import { analyzeProfiles, type AnalysisReport } from '../analyze';
import { compareReports } from '../compare';
import type { HermesProfile } from '../mergeProfiles';
import type { SymbolicatedFrame } from '../symbolicate';
import accuracy from './__fixtures__/accuracy.json';

// Real captures of the same workload (example/src/accuracyRun.ts) on an Android 15 device,
// with the task windows the app measured itself (ground truth).
type Capture = {
  pid: number;
  tid: number;
  stackFrames: Record<
    string,
    {
      name: string;
      category: string;
      parent?: number;
      funcVirtAddr?: string;
      offset?: string;
    }
  >;
  samples: [ts: number, sf: number][];
  windows: [name: string, startUs: number, endUs: number][];
};
const captures = accuracy as unknown as Record<
  'acc100' | 'accr8' | 'acc1000',
  Capture
>;
const names = ['acc100', 'accr8', 'acc1000'] as const;

const toProfile = (capture: Capture): HermesProfile =>
  ({
    stackFrames: capture.stackFrames,
    samples: capture.samples.map(([ts, sf]) => ({
      ts: String(ts),
      pid: capture.pid,
      tid: capture.tid,
      sf,
    })),
  } as unknown as HermesProfile);

/** Frames named by Hermes, located by bytecode offset (no source map needed for timing). */
const framesOf = (capture: Capture) =>
  new Map(
    Object.entries(capture.stackFrames).map(
      ([key, f]): [string, SymbolicatedFrame] => {
        const kind =
          f.category === 'root'
            ? 'root'
            : f.category === 'JavaScript'
            ? 'js'
            : f.category === 'Native'
            ? 'native'
            : 'meta';
        if (kind !== 'js' || f.funcVirtAddr === undefined)
          return [
            key,
            { name: f.name, function: f.name, functionId: f.name, kind },
          ];
        const start = Number(f.funcVirtAddr);
        const line = start + Number(f.offset);
        const fn = f.name || '(anonymous)';
        return [
          key,
          {
            name: `${fn} (bundle.js:${line})`,
            function: fn,
            functionId: `1:${start}`,
            functionLine: start,
            kind,
            source: 'bundle.js',
            line,
            column: 1,
            entry: Number(f.offset) === 0,
          },
        ];
      }
    )
  );

const analyzeCapture = (
  capture: Capture,
  longTaskMs = 50,
  profile = toProfile(capture)
) =>
  analyzeProfiles({
    profile,
    frames: framesOf(capture),
    symbolicatedFrames: 1,
    unmappedFrames: 0,
    longTaskMs,
    top: 15,
    root: '/project',
    sourceMapSha1: 'same-build',
  });

/** Scale the time owned by one function (by bytecode address), like a code change would. */
function scale(capture: Capture, address: string, factor: number) {
  const owner = (sf: number) => {
    for (
      let key: string | undefined = String(sf);
      key !== undefined && capture.stackFrames[key];
      key =
        capture.stackFrames[key]!.parent === undefined
          ? undefined
          : String(capture.stackFrames[key]!.parent)
    )
      if (capture.stackFrames[key]!.category === 'JavaScript')
        return capture.stackFrames[key]!.funcVirtAddr;
    return undefined;
  };
  const samples: [number, number][] = [];
  let shift = 0;
  let carry = 0;
  capture.samples.forEach(([ts, sf], i) => {
    const gap = (capture.samples[i + 1]?.[0] ?? ts + 10_000) - ts;
    if (owner(sf) !== address) {
      samples.push([ts + shift, sf]);
      return;
    }
    carry += factor;
    const copies = Math.floor(carry + 1e-9);
    carry -= copies;
    for (let j = 0; j < copies; j++) samples.push([ts + shift + j * gap, sf]);
    shift += (copies - 1) * gap;
  });
  return { ...capture, samples };
}

describe('analyze on real captures (ground truth)', () => {
  it.each(names)('finds the long tasks of %s at their real times', (name) => {
    const capture = captures[name];
    const report = analyzeCapture(capture);
    const first = capture.samples[0]![0];
    const interval = report.quality.jsIntervalMs.median;
    for (const [task, startUs, endUs] of capture.windows) {
      const start = (startUs - first) / 1000;
      const end = (endUs - first) / 1000;
      const found = report.js.longTasks.find(
        (t) => t.startMs < end && t.startMs + t.durationMs > start
      );
      if (end - start < 50) {
        expect(found).toBeUndefined();
        continue;
      }
      // A ~51 ms task sits on the 50 ms threshold; sampling can put it on either side.
      if (end - start < 55 && !found) continue;
      expect(found?.topFunctions[0]!.function).toBe(task);
      // Edges are midpoints between the last idle and first busy sample (and vice versa):
      // unbiased, and within one interval of the real start and end.
      expect(Math.abs(found!.startMs - start)).toBeLessThan(interval);
      expect(Math.abs(found!.startMs + found!.durationMs - end)).toBeLessThan(
        interval
      );
    }
  });
});

describe('compare on real captures', () => {
  const pairs = names.flatMap((a) =>
    names.filter((b) => b !== a).map((b) => [a, b] as const)
  );

  it.each([50, 60, 70, 100, 150, 200, 250, 300])(
    'finds nothing significant between runs of the same workload (long tasks ≥ %i ms)',
    (longTaskMs) => {
      const reports = Object.fromEntries(
        names.map((name) => [name, analyzeCapture(captures[name], longTaskMs)])
      ) as Record<(typeof names)[number], AnalysisReport>;
      for (const [a, b] of pairs) {
        const c = compareReports(reports[a], reports[b]);
        const significant = [
          ['busyMs', c.busyMs],
          ['gcMs', c.gcMs],
          ['longTasks.count', c.longTasks.count],
          ['longTasks.totalMs', c.longTasks.totalMs],
          ['longTasks.maxMs', c.longTasks.maxMs],
          ...c.functions.map((f) => [f.id, f]),
        ]
          .filter(([, x]) => (x as { significant: boolean }).significant)
          .map(([key]) => `${a}→${b} ${key}`);
        expect(significant).toEqual([]);
      }
    }
  );

  // accr8 as "before", the acc100 capture with one function changed as "after".
  const variant = (address: string, factor: number) =>
    compareReports(
      analyzeCapture(captures.accr8),
      analyzeCapture(scale(captures.acc100, address, factor))
    );
  const changed = (c: ReturnType<typeof compareReports>, fn: string) =>
    c.functions.find((f) => f.function === fn)!;
  const ACC_MATH = '404037';
  const ACC_SORT = '404182';
  const ACC_JSON = '404321';
  const COMPARATOR = '624503';

  it('flags 20–40% changes of a hot function as significant', () => {
    expect(changed(variant(ACC_MATH, 0.8), 'accMath').significant).toBe(true);
    expect(changed(variant(ACC_MATH, 1.3), 'accMath').significant).toBe(true);
    expect(changed(variant(ACC_SORT, 1.4), 'accSort').significant).toBe(true);
    const json = variant(ACC_JSON, 1.4);
    expect(changed(json, 'accJson').significant).toBe(true);
    expect(json.longTasks.maxMs.significant).toBe(true);
  });

  it('flags a comparator called 5x as often in busy time and in the function', () => {
    const c = variant(COMPARATOR, 5);
    expect(c.busyMs.significant).toBe(true);
    expect(c.functions.find((f) => f.id.endsWith(':624503'))!.significant).toBe(
      true
    );
  });

  it('treats a 10% change as within run-to-run variation', () => {
    expect(changed(variant(ACC_MATH, 0.9), 'accMath').significant).toBe(false);
  });
});
