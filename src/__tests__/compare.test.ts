import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AnalysisReport, FunctionTime } from '../analyze';
import { compareReports, readReport } from '../compare';
import type { ProfilerError } from '../errors';

type Fn = [name: string, location: string | null, ms: number, runs?: number];

/** A report sampled every 10 ms; `functions` are [name, location, self ms, runs]. */
function report(
  options: {
    functions?: Fn[];
    tasks?: number[];
    busy?: [ms: number, runs: number];
    id?: string;
    longTaskMs?: number;
    sourceMapSha1?: string;
    legacyTop?: number;
    native?: { hz: number; js: number; main: number; total: number };
  } = {}
): AnalysisReport {
  const functions: FunctionTime[] = (options.functions ?? []).map(
    ([name, location, ms, runs = 1]) => ({
      id: location ? `${name}@${location.split('/').pop()}` : name,
      function: name,
      location,
      selfMs: ms,
      totalMs: ms,
      samples: Math.round(ms / 10),
      runs,
    })
  );
  const legacy = options.legacyTop !== undefined;
  const top = functions
    .slice(0, legacy ? options.legacyTop : 15)
    .map(({ id, runs, ...f }) => ({
      ...(legacy ? {} : { id, runs }),
      ...f,
      selfPct: 0,
      totalPct: 0,
      hotLines: [],
      lineUnknownMs: 0,
    }));
  const [busyMs, busyRuns] = options.busy ?? [1000, 10];
  return {
    version: 1,
    ...(legacy
      ? {}
      : {
          settings: {
            longTaskMs: options.longTaskMs ?? 50,
            top: 15,
            sourceMapSha1: options.sourceMapSha1 ?? null,
          },
        }),
    session: {
      id: options.id ?? null,
      packageName: 'com.example',
      pid: 1,
      androidApiLevel: 35,
      nativeStatus: null,
      nativeError: null,
    },
    quality: {
      jsSamples: 500,
      jsIntervalMs: { median: 10, p95: 12 },
      nativeSamples: options.native?.total ?? 0,
      nativeFrequencyHz: options.native?.hz ?? null,
      requestedFrequencyHz: null,
      warnings: [],
    },
    js: {
      windowMs: 5000,
      busyMs,
      busyRuns,
      idleMs: 5000 - busyMs,
      gcMs: 0,
      gcRuns: 0,
      topFunctions: top,
      ...(legacy ? {} : { functions }),
      topLeafFrames: [],
      longTasks: (options.tasks ?? []).map((durationMs) => ({
        startMs: 0,
        durationMs,
        samples: durationMs / 10,
      })),
    },
    native: options.native
      ? {
          jsThreadId: 2,
          samples: options.native.total,
          threads: [
            { tid: 2, label: 'JS thread', samples: options.native.js },
            { tid: 1, label: 'main', samples: options.native.main },
          ],
        }
      : { jsThreadId: 2, samples: 0, threads: [] },
  } as unknown as AnalysisReport;
}
const row = (c: ReturnType<typeof compareReports>, location: string) =>
  c.functions.find((f) => f.location === location);

describe('compareReports function matching', () => {
  it('keeps distinct same-named functions in one file apart', () => {
    const c = compareReports(
      report({
        functions: [
          ['(anonymous)', 'src/List.tsx:10', 300, 3],
          ['(anonymous)', 'src/List.tsx:50', 20, 2],
        ],
      }),
      report({
        functions: [
          ['(anonymous)', 'src/List.tsx:50', 20, 2],
          ['(anonymous)', 'src/List.tsx:10', 10, 1],
        ],
      })
    );
    expect(row(c, 'src/List.tsx:10')).toMatchObject({
      before: 300,
      after: 10,
      delta: -290,
      significant: true,
    });
    expect(row(c, 'src/List.tsx:50')).toMatchObject({
      before: 20,
      after: 20,
      significant: false,
    });
  });

  it('matches functions regardless of the directory analyze ran in', () => {
    const c = compareReports(
      report({ functions: [['accJson', 'src/accuracyRun.ts:39', 650, 3]] }),
      report({
        functions: [['accJson', '/home/ci/app/src/accuracyRun.ts:39', 640, 3]],
      })
    );
    expect(c.functions).toHaveLength(1);
    expect(c.functions[0]).toMatchObject({
      before: 650,
      after: 640,
      significant: false,
    });
    expect(c.warnings.join('\n')).not.toContain('in common');
  });

  it('follows a function whose definition moved when that is unambiguous', () => {
    const c = compareReports(
      report({ functions: [['renderRow', 'src/Row.tsx:10', 200, 2]] }),
      report({ functions: [['renderRow', 'src/Row.tsx:14', 100, 2]] })
    );
    expect(c.functions).toEqual([
      expect.objectContaining({ before: 200, after: 100, significant: true }),
    ]);
  });

  it('adds up functions it cannot tell apart instead of dropping one', () => {
    const c = compareReports(
      report({
        functions: [
          ['(anonymous)', 'a/index.js:1', 30],
          ['(anonymous)', 'b/index.js:1', 40],
        ],
      }),
      report({ functions: [['(anonymous)', 'a/index.js:1', 70]] })
    );
    expect(c.functions).toEqual([
      expect.objectContaining({ before: 70, after: 70, delta: 0 }),
    ]);
  });

  it('reads functions beyond the top rows from the full list (0 = not sampled)', () => {
    const functions = (f15: number, f16: number): Fn[] => [
      ...Array.from(
        { length: 14 },
        (_, i): Fn => [`f${i}`, `src/m${i}.ts:2`, 1000 - i * 10, 5]
      ),
      ['f15', 'src/m15.ts:2', f15, 5],
      ['f16', 'src/m16.ts:2', f16, 5],
    ];
    const c = compareReports(
      report({ functions: functions(100, 95) }),
      report({ functions: functions(94, 101) })
    );
    expect(row(c, 'src/m15.ts:2')).toMatchObject({
      before: 100,
      after: 94,
      significant: false,
    });
    expect(row(c, 'src/m16.ts:2')).toMatchObject({
      before: 95,
      after: 101,
      significant: false,
    });
    const gone = compareReports(
      report({ functions: [['f', 'src/f.ts:1', 200, 2]] }),
      report({ functions: [] })
    );
    expect(gone.functions[0]).toMatchObject({ after: 0, significant: true });
  });

  it('marks functions missing from an older top-N report as unknown, not 0', () => {
    const c = compareReports(
      report({
        functions: [
          ['accJson', 'src/a.ts:39', 650, 3],
          ['accSort', 'src/a.ts:20', 318, 6],
        ],
        legacyTop: 1,
      }),
      report({
        functions: [
          ['accJson', 'src/a.ts:39', 640, 3],
          ['accSort', 'src/a.ts:20', 320, 6],
        ],
      })
    );
    expect(row(c, 'src/a.ts:20')).toMatchObject({
      before: null,
      after: 320,
      delta: null,
      significant: false,
    });
    expect(c.warnings.join('\n')).toContain('lists only its top 1 functions');
  });
});

describe('compareReports noise model', () => {
  const one = (before: Fn, after: Fn) =>
    compareReports(
      report({ functions: [before] }),
      report({ functions: [after] })
    ).functions[0]!.significant;

  it('judges contiguous work by its runs, not by the square root of its samples', () => {
    // 500 ms in 4 runs: 2 sd = 2·10·√8 ≈ 57 ms, so a 20% (100 ms) fix is real.
    expect(one(['f', 'a.ts:1', 500, 4], ['f', 'a.ts:1', 400, 4])).toBe(true);
    expect(one(['f', 'a.ts:1', 500, 4], ['f', 'a.ts:1', 455, 4])).toBe(false);
    // One contiguous block: measured to ±1 interval at each edge.
    expect(one(['f', 'a.ts:1', 100, 1], ['f', 'a.ts:1', 150, 1])).toBe(true);
    expect(one(['f', 'a.ts:1', 100, 1], ['f', 'a.ts:1', 125, 1])).toBe(false);
  });

  it('treats work spread over many short runs as binomial noise', () => {
    // 60 → 100 ms in 6 and 10 runs: 2 sd = 2·10·√16 = 80 ms.
    expect(one(['cmp', 'a.ts:2', 60, 6], ['cmp', 'a.ts:2', 100, 10])).toBe(
      false
    );
    expect(one(['cmp', 'a.ts:2', 60, 6], ['cmp', 'a.ts:2', 160, 16])).toBe(
      true
    );
  });

  it('requires 10% for large changes', () => {
    expect(one(['f', 'a.ts:1', 10000, 1], ['f', 'a.ts:1', 10900, 1])).toBe(
      false
    );
  });

  it('uses the busy runs for busy time', () => {
    const busy = (after: number) =>
      compareReports(
        report({ busy: [2000, 12] }),
        report({ busy: [after, 12] })
      ).busyMs.significant;
    expect(busy(2100)).toBe(false);
    expect(busy(2250)).toBe(true);
  });
});

describe('compareReports long tasks', () => {
  const lt = (before: number[], after: number[], longTaskMs = 50) =>
    compareReports(
      report({ tasks: before, longTaskMs }),
      report({ tasks: after, longTaskMs })
    ).longTasks;

  it('does not flag a task that crossed the threshold by sampling error', () => {
    // A 51 ms task measured just above or just below 50 ms.
    const c = lt([400, 250, 60.7], [404, 246]);
    expect(c.count).toMatchObject({ before: 3, after: 2, significant: false });
    expect(c.totalMs.significant).toBe(false);
    const up = lt([299.7, 208.2], [310.3, 312.8, 186.7], 300);
    expect(up.count.significant).toBe(false);
    expect(up.totalMs.significant).toBe(false);
  });

  it('flags a new long task', () => {
    expect(lt([400, 250], [400, 250, 300]).count.significant).toBe(true);
    // With a near-threshold task around, +1 could be that task crossing; the total can't.
    const c = lt([400, 250, 60], [400, 250, 60, 300]);
    expect(c.count.significant).toBe(false);
    expect(c.totalMs.significant).toBe(true);
    expect(lt([400], [400, 300]).maxMs.significant).toBe(false);
    expect(lt([400], [550]).maxMs.significant).toBe(true);
    expect(lt([], [300]).maxMs.significant).toBe(true);
    expect(lt([], [55]).maxMs.significant).toBe(false);
  });

  it('refuses to compare counts made with different thresholds', () => {
    const c = compareReports(
      report({ tasks: [400, 250, 60] }),
      report({ tasks: [400, 250], longTaskMs: 100 })
    );
    expect(c.longTasks.count.significant).toBe(false);
    expect(c.warnings.join('\n')).toContain('thresholds differ');
  });
});

describe('compareReports warnings', () => {
  it('warns when both reports analyze the same session', () => {
    const a = report({ id: 'abc', sourceMapSha1: 'x' });
    const c = compareReports(a, a);
    expect(c.warnings.join('\n')).toContain('same session (abc)');
  });

  it('notes when both reports come from the same JS build', () => {
    const c = compareReports(
      report({ id: 'a', sourceMapSha1: 'x' }),
      report({ id: 'b', sourceMapSha1: 'x' })
    );
    expect(c.warnings.join('\n')).toContain('same JS build');
  });

  it('warns when the reports share no functions', () => {
    const c = compareReports(
      report({ functions: [['accJson', 'src/a.ts:39', 650, 3]] }),
      report({ functions: [['startApp', 'src/App.tsx:5', 640, 3]] })
    );
    expect(c.warnings.join('\n')).toContain('share no JS functions');
  });

  it('compares native CPU per thread when both reports have native samples', () => {
    const c = compareReports(
      report({ native: { hz: 100, js: 195, main: 17, total: 227 } }),
      report({ native: { hz: 100, js: 195, main: 60, total: 270 } })
    );
    expect(c.native?.threads).toEqual([
      expect.objectContaining({
        thread: 'JS thread',
        before: 1950,
        after: 1950,
      }),
      expect.objectContaining({
        thread: 'main',
        before: 170,
        after: 600,
        significant: true,
      }),
      expect.objectContaining({ thread: 'other threads', before: 150 }),
    ]);
    const jsOnly = compareReports(report(), report());
    expect(jsOnly.native).toBeNull();
    expect(jsOnly.warnings.join('\n')).toContain(
      'Native threads are not compared: neither report has native samples'
    );
    const oneSided = compareReports(
      report({ native: { hz: 100, js: 195, main: 17, total: 227 } }),
      report()
    );
    expect(oneSided.warnings.join('\n')).toContain(
      'the after report has no native samples'
    );
  });
});

describe('readReport', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrp-compare-'));
  const file = (name: string, content: string) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, content);
    return target;
  };
  const codeOf = (target: string) => {
    try {
      readReport(target);
    } catch (error) {
      return [(error as ProfilerError).code, (error as Error).message];
    }
    return undefined;
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads reports and --json envelopes', () => {
    const r = report();
    expect(readReport(file('r.json', JSON.stringify(r)))).toEqual(r);
    expect(
      readReport(
        file(
          'e.json',
          JSON.stringify({ ok: true, command: 'analyze', result: r })
        )
      )
    ).toEqual(r);
  });

  it('rejects inputs that are not analyze reports with E_USAGE', () => {
    expect(codeOf(path.join(dir, 'nope.json'))![0]).toBe('E_USAGE');
    expect(codeOf(file('r.md', '# Profile analysis'))).toEqual([
      'E_USAGE',
      expect.stringContaining('is not JSON'),
    ]);
    expect(
      codeOf(
        file(
          'failed.json',
          JSON.stringify({
            ok: false,
            command: 'analyze',
            error: { code: 'E_SOURCEMAP_MISMATCH', message: 'wrong map' },
          })
        )
      )
    ).toEqual(['E_USAGE', expect.stringContaining('E_SOURCEMAP_MISMATCH')]);
    expect(
      codeOf(file('session.json', JSON.stringify({ version: 1, pid: 1 })))
    ).toEqual([
      'E_USAGE',
      expect.stringContaining('not a valid analyze report'),
    ]);
    const zero = report();
    zero.quality.jsIntervalMs.median = 0;
    expect(codeOf(file('zero.json', JSON.stringify(zero)))![0]).toBe('E_USAGE');
  });
});
