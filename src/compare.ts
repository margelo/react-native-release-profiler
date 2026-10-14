import fs from 'fs';
import { functionIdentity, type AnalysisReport } from './analyze';
import { ProfilerError } from './errors';

export interface Change {
  before: number;
  after: number;
  delta: number;
  /** False when the change is within sampling noise (see `compareReports`) or under 10%. */
  significant: boolean;
}

export interface FunctionChange {
  /** Function identity (name, file name, definition line); see `FunctionTime.id`. */
  id: string;
  function: string;
  location: string | null;
  /** Self ms; null when unknown (an older report that lists only its top functions). */
  before: number | null;
  after: number | null;
  delta: number | null;
  significant: boolean;
}

export interface Comparison {
  version: 1;
  before: string | null;
  after: string | null;
  busyMs: Change;
  gcMs: Change;
  longTasks: { count: Change; totalMs: Change; maxMs: Change };
  functions: FunctionChange[];
  /** Sampled native CPU ms by thread, when both reports have native samples. */
  native: { threads: ({ thread: string } & Change)[] } | null;
  warnings: string[];
}

const round = (value: number) => Math.round(value * 10) / 10;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Read an `analyze` report (`--output <file>.json` or the `--json` envelope). */
export function readReport(file: string): AnalysisReport {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ProfilerError(
      'E_USAGE',
      `Cannot read report ${file}: ${(error as Error).message}`
    );
  }
  const hint =
    'compare reads analyze reports: `analyze … --output <file>.json` or `analyze … --json`';
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfilerError('E_USAGE', `${file} is not JSON; ${hint}`);
  }
  if (parsed?.ok === false)
    throw new ProfilerError(
      'E_USAGE',
      `${file} holds a failed ${parsed.command ?? 'command'} (${
        parsed.error?.code ?? 'error'
      }: ${parsed.error?.message ?? 'unknown'}); fix that and re-run analyze`
    );
  const report = parsed?.command === 'analyze' ? parsed.result : parsed;
  const interval = report?.quality?.jsIntervalMs?.median;
  if (
    report?.version !== 1 ||
    !report.session ||
    typeof report.js?.busyMs !== 'number' ||
    !Array.isArray(report.js.topFunctions) ||
    !Array.isArray(report.js.longTasks) ||
    !(typeof interval === 'number' && interval > 0)
  )
    throw new ProfilerError(
      'E_USAGE',
      `${file} is not a valid analyze report; ${hint}`
    );
  return report as AnalysisReport;
}

type Row = {
  id: string;
  function: string;
  location: string | null;
  ms: number;
  runs: number;
};

/**
 * Compare two analyze reports of the same scenario.
 *
 * Noise model: Hermes samples the JS thread periodically. A stretch of consecutive samples
 * (a "run") measures its true length to within about one interval at each edge, and stretches
 * shorter than an interval are caught or missed (binomially). Either way the error variance is
 * at most about one interval² per run, so the difference of two reports has
 * sd ≤ interval·√(runsBefore + runsAfter). A change is significant beyond 2 sd of that and
 * beyond 10% (the app's own run-to-run variation). Long-task counts and totals also allow for
 * tasks within 2 intervals of the threshold, which can cross it in either direction.
 */
export function compareReports(
  before: AnalysisReport,
  after: AnalysisReport,
  top = 15
): Comparison {
  const interval = Math.max(
    before.quality.jsIntervalMs.median,
    after.quality.jsIntervalMs.median
  );
  const twoSd = (runs: number) => 2 * interval * Math.sqrt(runs);
  const change = (a: number, b: number, noise: number): Change => ({
    before: round(a),
    after: round(b),
    delta: round(b - a),
    significant: Math.abs(b - a) > Math.max(noise, 0.1 * Math.max(a, b)),
  });
  const runsOf = (ms: number, runs: number | undefined) =>
    runs ?? Math.ceil(ms / interval);
  const warnings: string[] = [];

  // --- Long tasks ---
  const threshold = (r: AnalysisReport) => r.settings?.longTaskMs ?? 50;
  const durations = (r: AnalysisReport) =>
    r.js.longTasks.map((t) => t.durationMs);
  const nearThreshold = (r: AnalysisReport) =>
    durations(r).filter((d) => d < threshold(r) + 2 * interval);
  const sameThreshold = threshold(before) === threshold(after);
  if (!sameThreshold)
    warnings.push(
      `Long-task thresholds differ (${threshold(before)} vs ${threshold(
        after
      )} ms); long-task count and total are not comparable`
    );
  const [countA, countB] = [before, after].map((r) => r.js.longTasks.length);
  const [totalA, totalB] = [before, after].map((r) => sum(durations(r)));
  const [maxA, maxB] = [before, after].map((r) => Math.max(0, ...durations(r)));
  const crossing = (a: number, b: number) =>
    b > a ? nearThreshold(after) : nearThreshold(before);
  const count = change(countA!, countB!, 0);
  count.significant &&=
    sameThreshold &&
    Math.abs(countB! - countA!) > crossing(countA!, countB!).length;
  const totalMs = change(
    totalA!,
    totalB!,
    twoSd(countA! + countB!) + sum(crossing(totalA!, totalB!))
  );
  totalMs.significant &&= sameThreshold;
  // A side without long tasks has its longest task somewhere below the threshold.
  const maxMs = change(maxA!, maxB!, 0);
  maxMs.significant = change(
    countA ? maxA! : threshold(before),
    countB ? maxB! : threshold(after),
    twoSd(2)
  ).significant;

  // --- Functions ---
  const rowsOf = (r: AnalysisReport) => {
    const complete = Array.isArray(r.js.functions);
    const rows = new Map<string, Row>();
    for (const f of complete ? r.js.functions : r.js.topFunctions) {
      const id = f.id ?? functionIdentity(f.function, f.location);
      const runs = runsOf(f.selfMs, f.runs ?? f.samples);
      const row = rows.get(id);
      // Functions that share name, file name and definition line can't be told apart
      // across reports; add them up rather than letting one hide the other.
      if (row) {
        row.ms += f.selfMs;
        row.runs += runs;
      } else
        rows.set(id, {
          id,
          function: f.function,
          location: f.location,
          ms: f.selfMs,
          runs,
        });
    }
    return { rows, complete };
  };
  const a = rowsOf(before);
  const b = rowsOf(after);
  for (const [side, label] of [
    [a, 'before'],
    [b, 'after'],
  ] as const)
    if (!side.complete)
      warnings.push(
        `The ${label} report comes from an older analyze and lists only its top ${side.rows.size} functions (others are shown as ?); re-run analyze for a complete comparison`
      );
  const pairs: [Row | undefined, Row | undefined][] = [];
  const restA = new Map(a.rows);
  const restB = new Map(b.rows);
  for (const [id, row] of a.rows) {
    const other = b.rows.get(id);
    if (other) {
      pairs.push([row, other]);
      restA.delete(id);
      restB.delete(id);
    }
  }
  // Edits move definition lines: pair the rest by name and file when that is unambiguous.
  const loose = (row: Row) => (row.location ? row.id.replace(/:\d+$/, '') : '');
  const group = (rows: Map<string, Row>) => {
    const groups = new Map<string, Row[]>();
    for (const row of rows.values())
      if (loose(row))
        groups.set(loose(row), [...(groups.get(loose(row)) ?? []), row]);
    return groups;
  };
  const groupsB = group(restB);
  for (const [key, rows] of group(restA)) {
    const others = groupsB.get(key);
    if (rows.length === 1 && others?.length === 1) {
      pairs.push([rows[0], others[0]]);
      restA.delete(rows[0]!.id);
      restB.delete(others[0]!.id);
    }
  }
  for (const row of restA.values()) pairs.push([row, undefined]);
  for (const row of restB.values()) pairs.push([undefined, row]);
  const functions: FunctionChange[] = pairs
    .map(([x, y]) => {
      const row = (y ?? x)!;
      const valueA = x ? x.ms : a.complete ? 0 : null;
      const valueB = y ? y.ms : b.complete ? 0 : null;
      const known = valueA !== null && valueB !== null;
      return {
        id: row.id,
        function: row.function,
        location: row.location,
        before: valueA === null ? null : round(valueA),
        after: valueB === null ? null : round(valueB),
        delta: known ? round(valueB - valueA) : null,
        significant:
          known &&
          change(valueA, valueB, twoSd((x?.runs ?? 0) + (y?.runs ?? 0)))
            .significant,
      };
    })
    .sort(
      (x, y) =>
        Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) ||
        Math.max(y.before ?? 0, y.after ?? 0) -
          Math.max(x.before ?? 0, x.after ?? 0)
    )
    .slice(0, top);
  const shared = (rows: Map<string, Row>, matched: (Row | undefined)[]) => {
    const all = sum([...rows.values()].map((row) => row.ms));
    return all ? sum(matched.map((row) => row?.ms ?? 0)) / all : 1;
  };
  const both = pairs.filter(([x, y]) => x && y);
  const sharedA = shared(
    a.rows,
    both.map(([x]) => x)
  );
  const sharedB = shared(
    b.rows,
    both.map(([, y]) => y)
  );
  const percent = (share: number) => `${Math.round(100 * share)}%`;
  if (a.rows.size && b.rows.size && sharedA < 0.5 && sharedB < 0.5)
    warnings.push(
      (both.length
        ? `The reports have little JS in common (${percent(sharedA)} and ` +
          `${percent(sharedB)} of self time is in shared functions)`
        : 'The reports share no JS functions') +
        '; compare the same scenario on comparable builds'
    );

  // --- Scenario and capture checks ---
  if (
    before.session.packageName &&
    after.session.packageName &&
    before.session.packageName !== after.session.packageName
  )
    warnings.push('Reports come from different apps');
  if (before.session.id && before.session.id === after.session.id)
    warnings.push(
      `Both reports analyze the same session (${before.session.id}); record a new session for "after" (was a new one pulled?)`
    );
  else if (
    before.settings?.sourceMapSha1 &&
    before.settings.sourceMapSha1 === after.settings?.sourceMapSha1
  )
    warnings.push(
      'Both reports come from the same JS build (identical source map): differences are run-to-run variation, not a JS code change'
    );
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

  // --- Native (CPU time sampled per thread) ---
  const nativeOf = (r: AnalysisReport) => {
    const hz = r.quality.nativeFrequencyHz ?? r.quality.requestedFrequencyHz;
    const total = r.native?.samples ?? r.quality.nativeSamples;
    if (!hz || !total || !Array.isArray(r.native?.threads)) return null;
    const of = (label: string) =>
      r.native.threads.find((t) => t.label === label)?.samples ?? 0;
    const js = of('JS thread');
    const main = of('main');
    return {
      period: 1000 / hz,
      threads: {
        'JS thread': js,
        'main': main,
        'other threads': total - js - main,
      } as Record<string, number>,
    };
  };
  const nativeA = nativeOf(before);
  const nativeB = nativeOf(after);
  if (nativeA && nativeB && nativeA.period !== nativeB.period)
    warnings.push(
      `Native sampling rates differ (${round(1000 / nativeA.period)} vs ${round(
        1000 / nativeB.period
      )} Hz); native CPU times are only roughly comparable`
    );
  if (!nativeA || !nativeB)
    warnings.push(
      `Native threads are not compared: ${
        nativeA || nativeB
          ? `the ${nativeA ? 'after' : 'before'} report has no`
          : 'neither report has'
      } native samples`
    );
  const native =
    nativeA && nativeB
      ? {
          threads: Object.keys(nativeA.threads).map((thread) => {
            const [samplesA, samplesB] = [
              nativeA.threads[thread]!,
              nativeB.threads[thread]!,
            ];
            // Native samples are counts of a CPU-time sampler: Poisson noise.
            return {
              thread,
              ...change(
                samplesA * nativeA.period,
                samplesB * nativeB.period,
                2 *
                  Math.sqrt(
                    samplesA * nativeA.period ** 2 +
                      samplesB * nativeB.period ** 2
                  )
              ),
            };
          }),
        }
      : null;

  return {
    version: 1,
    before: before.session.id,
    after: after.session.id,
    busyMs: change(
      before.js.busyMs,
      after.js.busyMs,
      twoSd(
        runsOf(before.js.busyMs, before.js.busyRuns) +
          runsOf(after.js.busyMs, after.js.busyRuns)
      )
    ),
    gcMs: change(
      before.js.gcMs,
      after.js.gcMs,
      twoSd(
        runsOf(before.js.gcMs, before.js.gcRuns) +
          runsOf(after.js.gcMs, after.js.gcRuns)
      )
    ),
    longTasks: { count, totalMs, maxMs },
    functions,
    native,
    warnings,
  };
}

export function renderComparison(c: Comparison): string {
  const signed = (x: number) => `${x > 0 ? '+' : ''}${x}`;
  const fmt = (x: Change) =>
    `${x.before} → ${x.after} (${signed(x.delta)})${
      x.significant ? '' : ' ~noise'
    }`;
  const value = (x: number | null) => (x === null ? '?' : String(x));
  return [
    `# Profile comparison`,
    '',
    `Before: ${c.before ?? 'profile'} · after: ${c.after ?? 'profile'}`,
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
        `| ${f.function} | ${f.location ?? ''} | ${value(f.before)} | ${value(
          f.after
        )} | ${f.delta === null ? '?' : signed(f.delta)} | ${
          f.significant ? 'yes' : 'no'
        } |`
    ),
    ...(c.native
      ? [
          '',
          '## Native CPU (sampled ms)',
          '',
          '| thread | before | after | Δ | significant |',
          '|---|---|---|---|---|',
          ...c.native.threads.map(
            (t) =>
              `| ${t.thread} | ${t.before} | ${t.after} | ${signed(
                t.delta
              )} | ${t.significant ? 'yes' : 'no'} |`
          ),
        ]
      : []),
    '',
  ].join('\n');
}
