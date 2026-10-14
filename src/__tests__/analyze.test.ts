import fs from 'fs';
import os from 'os';
import path from 'path';
import { SourceMapGenerator } from 'source-map';
import { analyze, analyzeProfiles } from '../analyze';
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
    // Busy from the sample at 30 ms to the idle one at 110 ms: the task started after the
    // idle sample at 20 ms and ended before 110 ms, so the edges are the midpoints.
    expect(task).toMatchObject({ startMs: 25, durationMs: 80, samples: 8 });
    expect(task!.topFunctions[0]).toMatchObject({
      function: 'task',
      location: 'src/app.ts:10',
      hotLine: 'src/app.ts:12',
      hotLineMs: 80,
      lineUnknownMs: 0,
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

describe('analyzeProfiles timing and attribution', () => {
  it('shows entry frames as the definition, not as an executing line', () => {
    const report = run('ieeeeeniiiiii');
    expect(report.js.topLeafFrames[0]).toMatchObject({
      frame: 'task (defined at src/app.ts:10)',
      ms: 50,
    });
    const [task] = report.js.longTasks;
    expect(task!.heaviestStack).toEqual(['task (defined at src/app.ts:10)']);
    // One sample of six has a known line: too little to name a hot line for the task.
    expect(task!.topFunctions[0]).toMatchObject({
      function: 'task',
      hotLine: null,
      hotLineMs: 10,
      lineUnknownMs: 50,
      ms: 60,
    });
  });

  it('separates self and total time of callers and callees', () => {
    const js = (
      id: string,
      fn: string,
      file: string,
      line: number
    ): [string, SymbolicatedFrame] => [
      id,
      {
        name: `${fn} (${file}:${line}:1)`,
        function: fn,
        functionId: `1:${id}`,
        functionLine: line,
        kind: 'js',
        source: file,
        line,
        column: 1,
      },
    ];
    const report = analyzeProfiles({
      profile: {
        stackFrames: {
          1: { name: '[root]', category: 'root' },
          2: { name: 'outer', category: 'JavaScript', parent: 1 },
          3: { name: 'inner', category: 'JavaScript', parent: 2 },
        },
        samples: [1, 2, 2, 3, 3, 3, 1].map((sf, i) => ({
          ts: String(1_000_000 + i * 10_000),
          pid: 1,
          tid: 2,
          sf,
        })),
      } as unknown as HermesProfile,
      frames: new Map([
        ['1', frames.get('1')!],
        js('2', 'outer', 'src/o.ts', 5),
        js('3', 'inner', 'src/i.ts', 9),
      ]),
      symbolicatedFrames: 2,
      unmappedFrames: 0,
      longTaskMs: 50,
      top: 10,
      root: '/project',
    });
    const by = (fn: string) =>
      report.js.topFunctions.find((f) => f.function === fn);
    expect(by('outer')).toMatchObject({ selfMs: 20, totalMs: 50, runs: 1 });
    expect(by('inner')).toMatchObject({ selfMs: 30, totalMs: 30, runs: 1 });
    expect(report.js.functions.map((f) => f.id)).toEqual([
      'inner@i.ts:9',
      'outer@o.ts:5',
    ]);
  });

  it('names a function after its frame nearest the definition, whatever is sampled first', () => {
    const frame = (
      id: string,
      fn: string,
      line: number
    ): [string, SymbolicatedFrame] => [
      id,
      {
        name: `${fn} (src/r.ts:${line}:1)`,
        function: fn,
        functionId: '1:500',
        kind: 'js',
        source: 'src/r.ts',
        line,
        column: 1,
      },
    ];
    const label = (order: number[]) =>
      analyzeProfiles({
        profile: {
          stackFrames: {
            1: { name: '[root]', category: 'root' },
            2: { name: '', category: 'JavaScript', parent: 1 },
            3: { name: '', category: 'JavaScript', parent: 1 },
          },
          samples: order.map((sf, i) => ({
            ts: String(1_000_000 + i * 10_000),
            pid: 1,
            tid: 2,
            sf,
          })),
        } as unknown as HermesProfile,
        frames: new Map([
          ['1', frames.get('1')!],
          frame('2', 'formatRow', 30),
          frame('3', 'buildReport', 10),
        ]),
        symbolicatedFrames: 2,
        unmappedFrames: 0,
        longTaskMs: 50,
        top: 10,
        root: '/project',
      }).js.functions.map((f) => [f.function, f.id]);
    expect(label([2, 3, 2])).toEqual([['buildReport', 'buildReport@r.ts:10']]);
    expect(label([3, 2, 2])).toEqual(label([2, 3, 2]));
  });

  it("analyzes the JS thread alone when another Hermes thread's samples interleave", () => {
    // tid 2 busy for 1 s; an idle second runtime on tid 9 sampled 5 ms after each sample.
    const busy = profile('i' + 'n'.repeat(100) + 'i');
    const mixed = {
      ...busy,
      samples: busy.samples.flatMap((s) => [
        s,
        { ...s, ts: String(Number(s.ts) + 5_000), tid: 9, sf: 1 },
      ]),
    } as HermesProfile;
    const report = analyzeProfiles({
      profile: mixed,
      frames,
      symbolicatedFrames: 2,
      unmappedFrames: 0,
      longTaskMs: 50,
      top: 10,
      root: '/project',
    });
    expect(report.quality.jsIntervalMs.median).toBe(10);
    expect(report.js.busyMs).toBe(1000);
    expect(report.js.longTasks.map((t) => t.durationMs)).toEqual([1000]);
    expect(report.native.jsThreadId).toBe(2);
    expect(report.quality.otherJsThreads).toEqual([{ tid: 9, samples: 102 }]);
    expect(report.quality.warnings.join('\n')).toContain('tid 9: 102');
  });

  it('rejects samples whose stack frames are missing instead of counting them idle', () => {
    const broken = profile('innni');
    broken.samples[2]!.sf = 424242;
    expect(() =>
      analyzeProfiles({
        profile: broken,
        frames,
        symbolicatedFrames: 2,
        unmappedFrames: 0,
        longTaskMs: 50,
        top: 10,
        root: '/project',
      })
    ).toThrow('Missing Hermes stack frame 424242');
  });

  /** Samples at explicit times (ms): i = idle, n = busy. */
  const timed = (points: [number, 'i' | 'n'][]) =>
    analyzeProfiles({
      profile: {
        stackFrames,
        samples: points.map(([t, c]) => ({
          ts: String(1_000_000 + t * 1000),
          pid: 1,
          tid: 2,
          sf: c === 'i' ? 1 : 4,
        })),
      } as unknown as HermesProfile,
      frames,
      symbolicatedFrames: 2,
      unmappedFrames: 0,
      longTaskMs: 50,
      top: 10,
      root: '/project',
    });
  const every10 = (from: number, to: number, c: 'i' | 'n') =>
    Array.from(
      { length: (to - from) / 10 + 1 },
      (_, i): [number, 'i' | 'n'] => [from + i * 10, c]
    );

  it('counts a task of exactly the threshold as long', () => {
    const report = timed([
      ...every10(0, 40, 'i'),
      ...every10(50, 90, 'n'),
      ...every10(100, 200, 'i'),
    ]);
    expect(report.js.longTasks.map((t) => [t.startMs, t.durationMs])).toEqual([
      [45, 50],
    ]);
  });

  it('splits tasks at long sampler gaps and caps the time a gap adds', () => {
    // Busy on both sides of a 150 ms gap (over the 100 ms limit): two tasks, and the gap
    // adds at most one interval to each side instead of 150 ms of busy time.
    const report = timed([
      ...every10(0, 40, 'i'),
      ...every10(50, 100, 'n'),
      ...every10(250, 300, 'n'),
      ...every10(310, 400, 'i'),
    ]);
    expect(report.js.longTasks.map((t) => [t.startMs, t.durationMs])).toEqual([
      [45, 65],
      [240, 65],
    ]);
    expect(report.js.busyMs).toBe(130);
  });

  it('keeps one task across a shorter sampler gap, which a busy thread causes', () => {
    const report = timed([
      ...every10(0, 40, 'i'),
      ...every10(50, 100, 'n'),
      ...every10(180, 230, 'n'),
      ...every10(240, 400, 'i'),
    ]);
    expect(report.js.longTasks.map((t) => [t.startMs, t.durationMs])).toEqual([
      [45, 190],
    ]);
  });

  it('treats debug-profile frames at their function start as unknown lines', () => {
    const debugFrame = (
      id: string,
      line: number,
      column: number
    ): [string, SymbolicatedFrame] => [
      id,
      {
        name: `longMathTask (src/App.tsx:${line}:${column})`,
        function: 'longMathTask',
        functionId: '83895:2',
        functionLine: 12,
        kind: 'js',
        source: 'src/App.tsx',
        line,
        column,
      },
    ];
    const report = analyzeProfiles({
      profile: {
        stackFrames: {
          1: { name: '[root]', category: 'root' },
          // Innermost interpreted frame: reported at the function's own start position.
          2: {
            name: 'longMathTask',
            category: 'JavaScript',
            parent: 1,
            line: '83895',
            column: '3',
            funcLine: '83895',
            funcColumn: '3',
          },
          3: {
            name: 'longMathTask',
            category: 'JavaScript',
            parent: 1,
            line: '83900',
            column: '5',
            funcLine: '83895',
            funcColumn: '3',
          },
        },
        samples: [1, 2, 2, 2, 3, 1].map((sf, i) => ({
          ts: String(1_000_000 + i * 10_000),
          pid: 1,
          tid: 2,
          sf,
        })),
      } as unknown as HermesProfile,
      frames: new Map([
        ['1', frames.get('1')!],
        debugFrame('2', 12, 3),
        debugFrame('3', 17, 5),
      ]),
      symbolicatedFrames: 2,
      unmappedFrames: 0,
      longTaskMs: 50,
      top: 10,
      root: '/project',
    });
    expect(report.js.topFunctions[0]).toMatchObject({
      hotLines: [{ location: 'src/App.tsx:17', ms: 10 }],
      lineUnknownMs: 30,
    });
    expect(report.quality.debugBuild).toBe(true);
    expect(report.quality.warnings.join('\n')).toContain('Debug build');
  });
});

describe('analyze code excerpts', () => {
  it('finds the source text of maps with a sourceRoot and relative sources', async () => {
    const generator = new SourceMapGenerator({ sourceRoot: 'app/' });
    const add = (column: number, line: number) =>
      generator.addMapping({
        generated: { line: 1, column },
        original: { line, column: 2 },
        source: './src/a.ts',
      });
    add(100, 3);
    add(104, 5);
    const text = [
      '// a.ts',
      '',
      'function task() {',
      '  let x = 0;',
      '  x = work();',
      '}',
    ];
    generator.setSourceContent('./src/a.ts', text.join('\n'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrp-analyze-'));
    try {
      const mapFile = path.join(dir, 'index.map');
      const profileFile = path.join(dir, 'p.cpuprofile');
      // Composed Hermes maps list function offsets; release profiles require them.
      fs.writeFileSync(
        mapFile,
        JSON.stringify({
          ...JSON.parse(generator.toString()),
          x_hermes_function_offsets: { 0: [0, 100] },
        })
      );
      fs.writeFileSync(
        profileFile,
        JSON.stringify({
          stackFrames: {
            1: { name: '[root]', category: 'root' },
            2: {
              name: 'task',
              category: 'JavaScript',
              parent: 1,
              funcVirtAddr: '100',
              offset: '4',
            },
          },
          samples: [1, 2, 2, 1].map((sf, i) => ({
            ts: String(1_000_000 + i * 10_000),
            pid: 1,
            tid: 2,
            sf,
          })),
        })
      );
      const report = await analyze({
        profile: profileFile,
        sourceMap: mapFile,
        root: dir,
      });
      expect(report.js.topFunctions[0]).toMatchObject({
        function: 'task',
        hotLines: [{ location: 'app/src/a.ts:5', ms: 20 }],
        code: [
          '3: function task() {',
          '4:   let x = 0;',
          '5:   x = work();',
          '6: }',
        ],
      });
      expect(report.settings).toMatchObject({ longTaskMs: 50, top: 15 });
      expect(report.settings.sourceMapSha1).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
