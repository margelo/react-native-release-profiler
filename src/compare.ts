import type { AnalysisReport } from './analyze';

export interface Change {
  before: number;
  after: number;
  delta: number;
  /** False when the change is within sampling noise (~2 sd of the sample count) or under 10%. */
  significant: boolean;
}

export interface Comparison {
  version: 1;
  before: string | null;
  after: string | null;
  busyMs: Change;
  gcMs: Change;
  longTasks: { count: Change; totalMs: Change; maxMs: Change };
  functions: ({ function: string; location: string | null } & Change)[];
  warnings: string[];
}

const round = (value: number) => Math.round(value * 10) / 10;

export function compareReports(
  before: AnalysisReport,
  after: AnalysisReport,
  top = 15
): Comparison {
  // Sample counts vary like a Poisson process (sd ≈ √n samples), so a change is
  // significant only beyond ~2 sd of the larger measurement, and beyond 10%.
  const interval = Math.max(
    before.quality.jsIntervalMs.median,
    after.quality.jsIntervalMs.median
  );
  const noiseFor = (a: number, b: number) =>
    2 * interval * Math.sqrt(Math.max(a, b, interval) / interval);
  const change = (a: number, b: number, floor = noiseFor(a, b)): Change => ({
    before: round(a),
    after: round(b),
    delta: round(b - a),
    significant: Math.abs(b - a) > Math.max(floor, 0.1 * Math.max(a, b)),
  });
  const durations = (r: AnalysisReport) =>
    r.js.longTasks.map((t) => t.durationMs);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const key = (f: { function: string; location: string | null }) =>
    `${f.function}\0${f.location?.replace(/:\d+$/, '') ?? ''}`;
  const functions = new Map<
    string,
    { function: string; location: string | null; before: number; after: number }
  >();
  for (const f of before.js.topFunctions)
    functions.set(key(f), {
      function: f.function,
      location: f.location,
      before: f.selfMs,
      after: 0,
    });
  for (const f of after.js.topFunctions) {
    const entry = functions.get(key(f)) ?? {
      function: f.function,
      location: f.location,
      before: 0,
      after: 0,
    };
    entry.after = f.selfMs;
    entry.location = f.location ?? entry.location;
    functions.set(key(f), entry);
  }
  const warnings: string[] = [];
  if (
    before.session.packageName &&
    after.session.packageName &&
    before.session.packageName !== after.session.packageName
  )
    warnings.push('Reports come from different apps');
  const window = (r: AnalysisReport) => r.js.windowMs;
  if (
    Math.abs(window(before) - window(after)) >
    0.2 * Math.max(window(before), window(after))
  )
    warnings.push(
      `Recording lengths differ (${window(before)} ms vs ${window(
        after
      )} ms); compare like-for-like scenarios`
    );
  return {
    version: 1,
    before: before.session.id,
    after: after.session.id,
    busyMs: change(before.js.busyMs, after.js.busyMs),
    gcMs: change(before.js.gcMs, after.js.gcMs),
    longTasks: {
      count: change(before.js.longTasks.length, after.js.longTasks.length, 0),
      totalMs: change(sum(durations(before)), sum(durations(after))),
      maxMs: change(
        Math.max(0, ...durations(before)),
        Math.max(0, ...durations(after))
      ),
    },
    functions: [...functions.values()]
      .map((f) => ({
        function: f.function,
        location: f.location,
        ...change(f.before, f.after),
      }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, top),
    warnings,
  };
}

export function renderComparison(c: Comparison): string {
  const fmt = (x: Change) =>
    `${x.before} → ${x.after} (${x.delta > 0 ? '+' : ''}${x.delta})${
      x.significant ? '' : ' ~noise'
    }`;
  return [
    `# Profile comparison`,
    '',
    `- JS busy ms: ${fmt(c.busyMs)}`,
    `- GC ms: ${fmt(c.gcMs)}`,
    `- Long tasks: ${fmt(c.longTasks.count)}, total ms ${fmt(
      c.longTasks.totalMs
    )}, max ms ${fmt(c.longTasks.maxMs)}`,
    ...(c.warnings.length
      ? ['', '**Warnings:**', ...c.warnings.map((w) => `- ${w}`)]
      : []),
    '',
    '| function | location | self ms before | after | Δ | significant |',
    '|---|---|---|---|---|---|',
    ...c.functions.map(
      (f) =>
        `| ${f.function} | ${f.location ?? ''} | ${f.before} | ${f.after} | ${
          f.delta > 0 ? '+' : ''
        }${f.delta} | ${f.significant ? 'yes' : 'no'} |`
    ),
    '',
  ].join('\n');
}
