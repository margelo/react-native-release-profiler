import { analyzeProfiles } from '../analyze';
import { compareReports } from '../compare';
import type { HermesProfile } from '../mergeProfiles';
import type { SymbolicatedFrame } from '../symbolicate';

// [root] → task (src/app.ts) → [Native] jsonParse; task frames at a statement and at entry.
const frames = new Map<string, SymbolicatedFrame>([
  ['1', { name: '[root]', function: '[root]', functionId: 'r', kind: 'root' }],
  [
    '2',
    {
      name: 'task (src/app.ts:10:1)',
      function: 'task',
      functionId: '1:400',
      functionLine: 10,
      kind: 'js',
      source: 'src/app.ts',
      line: 10,
      column: 1,
      entry: true,
    },
  ],
  [
    '3',
    {
      name: 'task (src/app.ts:12:5)',
      function: 'task',
      functionId: '1:400',
      functionLine: 10,
      kind: 'js',
      source: 'src/app.ts',
      line: 12,
      column: 5,
    },
  ],
  [
    '4',
    {
      name: '[Native] jsonParse',
      function: '[Native] jsonParse',
      functionId: 'n',
      kind: 'native',
    },
  ],
  [
    '5',
    {
      name: '[GC Young Gen]',
      function: '[GC Young Gen]',
      functionId: 'g',
      kind: 'meta',
    },
  ],
]);
const stackFrames = {
  1: { name: '[root]', category: 'root' },
  2: { name: 'task', category: 'JavaScript', parent: 1 },
  3: { name: 'task', category: 'JavaScript', parent: 1 },
  4: { name: '[Native] jsonParse', category: 'Native', parent: 3 },
  5: { name: '[GC Young Gen]', category: 'Metadata', parent: 3 },
};

/** One sample every 10 ms: `pattern` letters: i=idle, e=task at entry, n=task→jsonParse, g=GC. */
function profile(pattern: string): HermesProfile {
  const leaf = { i: 1, e: 2, n: 4, g: 5 } as Record<string, number>;
  return {
    stackFrames,
    samples: [...pattern].map((c, i) => ({
      ts: String(1_000_000 + i * 10_000),
      pid: 1,
      tid: 2,
      sf: leaf[c]!,
    })),
  } as unknown as HermesProfile;
}

const run = (pattern: string) =>
  analyzeProfiles({
    profile: profile(pattern),
    frames,
    symbolicatedFrames: 2,
    unmappedFrames: 0,
    longTaskMs: 50,
    top: 10,
    root: '/project',
  });

describe('analyzeProfiles', () => {
  it('finds long tasks that end at idle samples', () => {
    const report = run('iiinnnnngnniiieeiiiiiiii');
    expect(report.js.longTasks).toHaveLength(1);
    const [task] = report.js.longTasks;
    expect(task).toMatchObject({ startMs: 30, durationMs: 80, samples: 8 });
    expect(task!.topFunctions[0]).toMatchObject({
      function: 'task',
      location: 'src/app.ts:10',
      hotLine: 'src/app.ts:12',
    });
    expect(task!.heaviestStack).toEqual([
      'task (src/app.ts:12)',
      '[Native] jsonParse',
    ]);
  });

  it('charges builtins to the calling JS function and skips entry lines', () => {
    const report = run('iinnnnneeiii');
    const [task] = report.js.topFunctions;
    expect(task).toMatchObject({
      function: 'task',
      location: 'src/app.ts:10',
      selfMs: 70,
      samples: 7,
      // Entry samples (offset 0) don't point at a statement; the hot line is the call site.
      lineUnknownMs: 20,
    });
    expect(task!.hotLines).toEqual([{ location: 'src/app.ts:12', ms: 50 }]);
    expect(report.js.topLeafFrames[0]).toMatchObject({
      frame: '[Native] jsonParse',
      ms: 50,
    });
    expect(report.js.busyMs).toBe(70);
    expect(report.js.idleMs).toBe(50);
  });

  it('keeps distinct anonymous functions in one file apart', () => {
    const anon = (id: string, line: number): [string, SymbolicatedFrame] => [
      id,
      {
        name: `(anonymous) (src/app.ts:${line}:1)`,
        function: '(anonymous)',
        functionId: `1:${line}00`,
        functionLine: line,
        kind: 'js',
        source: 'src/app.ts',
        line,
        column: 1,
      },
    ];
    const report = analyzeProfiles({
      profile: {
        stackFrames: {
          1: { name: '[root]', category: 'root' },
          6: { name: '', category: 'JavaScript', parent: 1 },
          7: { name: '', category: 'JavaScript', parent: 1 },
        },
        samples: [6, 6, 6, 7].map((sf, i) => ({
          ts: String(1_000_000 + i * 10_000),
          pid: 1,
          tid: 2,
          sf,
        })),
      } as unknown as HermesProfile,
      frames: new Map([['1', frames.get('1')!], anon('6', 24), anon('7', 25)]),
      symbolicatedFrames: 2,
      unmappedFrames: 0,
      longTaskMs: 50,
      top: 10,
      root: '/project',
    });
    expect(report.js.topFunctions.map((f) => f.location)).toEqual([
      'src/app.ts:24',
      'src/app.ts:25',
    ]);
  });

  it('counts GC time', () => {
    expect(run('iinngnnii').js.gcMs).toBe(10);
  });
});

describe('compareReports', () => {
  it('treats sampling jitter as noise and flags real regressions', () => {
    const base = run('i' + 'n'.repeat(30) + 'i');
    const jitter = run('i' + 'n'.repeat(32) + 'i');
    const doubled = run('i' + 'n'.repeat(60) + 'i');
    expect(compareReports(base, jitter).functions[0]!.significant).toBe(false);
    const regression = compareReports(base, doubled);
    expect(regression.functions[0]).toMatchObject({
      function: 'task',
      delta: 300,
      significant: true,
    });
    expect(regression.longTasks.maxMs.significant).toBe(true);
  });
});
