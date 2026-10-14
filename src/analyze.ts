import fs from 'fs';
import path from 'path';
import { ProfilerError } from './errors';
import { libraryName } from './folded';
import {
  loadSession,
  type HermesProfile,
  type ProfileSessionManifest,
} from './mergeProfiles';
import { inspectNativeTrace } from './perfettoProto';
import { symbolicateFrames, type SymbolicatedFrame } from './symbolicate';
import { decodeStackSamples } from './traceSamples';

export interface FunctionStat {
  function: string;
  /** `file:line` where the function is defined, relative to the project root. */
  location: string | null;
  /** Time with this function at the top of the stack, including builtins it called directly. */
  selfMs: number;
  /** Time with this function anywhere on the stack. */
  totalMs: number;
  selfPct: number;
  totalPct: number;
  samples: number;
  /** Statements inside the function by self time. */
  hotLines: { location: string; ms: number }[];
  /** Self time whose line Hermes didn't record (innermost interpreted frame). */
  lineUnknownMs: number;
  /** Source around the hottest line (or the definition), `"<line>: <code>"`. */
  code?: string[];
}

export interface LongTask {
  startMs: number;
  durationMs: number;
  samples: number;
  /** `location` is the definition; `hotLine` the hottest known statement in this task. */
  topFunctions: {
    function: string;
    location: string | null;
    hotLine: string | null;
    ms: number;
  }[];
  /** Most frequent stack in the task, outermost first. */
  heaviestStack: string[];
  /** Native leaf frames sampled on the JS thread during the task. */
  nativeOnJsThread: { frame: string; library: string; samples: number }[];
}

export interface AnalysisReport {
  version: 1;
  session: {
    id: string | null;
    packageName: string | null;
    pid: number | null;
    androidApiLevel: number | null;
    nativeStatus: string | null;
    nativeError: string | null;
  };
  quality: {
    jsSamples: number;
    jsIntervalMs: { median: number; p95: number };
    nativeSamples: number;
    requestedFrequencyHz: number | null;
    nativeFrequencyHz: number | null;
    nativeRecordsLost: number;
    skippedNativeSamples: Record<string, number>;
    overlappingNativeSamples: number;
    symbolicatedFrames: number;
    unmappedFrames: number;
    warnings: string[];
  };
  js: {
    windowMs: number;
    busyMs: number;
    idleMs: number;
    gcMs: number;
    /** JS functions by self time (builtins they call count towards them). */
    topFunctions: FunctionStat[];
    /** Leaf frames as sampled, including builtins such as `[Native] jsonParse`. */
    topLeafFrames: { frame: string; ms: number; pct: number }[];
    longTasks: LongTask[];
  };
  native: {
    jsThreadId: number | null;
    threads: { tid: number; label: string; samples: number; pct: number }[];
    topFrames: {
      frame: string;
      library: string;
      samples: number;
      pct: number;
    }[];
    libraries: { library: string; samples: number; pct: number }[];
    jsThreadTopFrames: { frame: string; library: string; samples: number }[];
  };
}

const round = (value: number, digits = 1) =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const pct = (part: number, whole: number) =>
  whole ? round((100 * part) / whole) : 0;
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};
const topN = <K, T>(map: Map<K, T>, score: (v: T) => number, n: number) =>
  [...map].sort((a, b) => score(b[1]) - score(a[1])).slice(0, n);

export interface AnalyzeOptions {
  /** session.json or a directory containing it. */
  session?: string;
  /** A Hermes .cpuprofile without a session (JS-only, e.g. from stopProfiling()). */
  profile?: string;
  sourceMap: string;
  longTaskMs?: number;
  top?: number;
  /** Source paths are reported relative to this directory. */
  root?: string;
}

export async function analyze(
  options: AnalyzeOptions
): Promise<AnalysisReport> {
  let manifest: ProfileSessionManifest | undefined;
  let hermesPath = options.profile;
  let nativePath: string | null = null;
  for (const [label, file] of [
    ['Session', options.session],
    ['Profile', options.profile],
    ['Source map', options.sourceMap],
  ] as const)
    if (file && !fs.existsSync(file))
      throw new ProfilerError('E_USAGE', `${label} not found: ${file}`);
  if (options.session) {
    const sessionFile = fs.statSync(options.session).isDirectory()
      ? path.join(options.session, 'session.json')
      : options.session;
    const loaded = loadSession(sessionFile);
    manifest = loaded.manifest;
    hermesPath = loaded.hermesPath;
    nativePath = loaded.nativePath;
  }
  if (!hermesPath)
    throw new ProfilerError(
      'E_USAGE',
      'analyze needs a session (session.json or its directory) or --profile <file.cpuprofile>'
    );
  const profile = JSON.parse(
    fs.readFileSync(hermesPath, 'utf8')
  ) as HermesProfile;
  if (!profile.stackFrames || !profile.samples?.length)
    throw new ProfilerError(
      'E_HERMES_PROFILE',
      'Hermes profile has no samples or stack frames'
    );
  const sourceMapText = fs.readFileSync(options.sourceMap, 'utf8');
  const symbolicated = await symbolicateFrames(profile, sourceMapText);
  const map = JSON.parse(sourceMapText) as {
    sources?: string[];
    sourcesContent?: (string | null)[];
  };
  const contents = new Map<string, string>();
  map.sources?.forEach((file, i) => {
    const text = map.sourcesContent?.[i];
    if (text) contents.set(file, text);
  });
  return analyzeProfiles({
    profile,
    frames: symbolicated.frames,
    symbolicatedFrames: symbolicated.symbolicatedFrames,
    unmappedFrames: symbolicated.unmappedFrames,
    manifest,
    nativeTrace: nativePath ? fs.readFileSync(nativePath) : undefined,
    longTaskMs: options.longTaskMs ?? 50,
    top: options.top ?? 15,
    root: options.root ?? process.cwd(),
    sourceText: (file) => contents.get(file),
  });
}

export function analyzeProfiles(input: {
  profile: HermesProfile;
  frames: Map<string, SymbolicatedFrame>;
  symbolicatedFrames: number;
  unmappedFrames: number;
  manifest?: ProfileSessionManifest;
  nativeTrace?: Buffer;
  longTaskMs: number;
  top: number;
  root: string;
  /** Original source text (from the map's sourcesContent) for code excerpts. */
  sourceText?: (source: string) => string | undefined;
}): AnalysisReport {
  const { profile, frames, manifest, top, root } = input;
  const warnings: string[] = [];
  const source = (frame: SymbolicatedFrame) => {
    if (!frame.source) return null;
    const relative = path.isAbsolute(frame.source)
      ? path.relative(root, frame.source)
      : frame.source;
    return relative.startsWith('..') ? frame.source : relative;
  };
  const display = (frame: SymbolicatedFrame) =>
    frame.source
      ? `${frame.function} (${source(frame)}:${frame.line})`
      : frame.name;

  // --- JS (Hermes) samples, leaf-first stacks of frame keys ---
  const stackCache = new Map<string, string[]>();
  const stackOf = (leaf: string) => {
    let stack = stackCache.get(leaf);
    if (!stack) {
      stack = [];
      const seen = new Set<string>();
      for (let key: string | undefined = leaf; key !== undefined; ) {
        const frame: HermesProfile['stackFrames'][string] | undefined =
          profile.stackFrames[key];
        if (!frame || seen.has(key)) break;
        seen.add(key);
        stack.push(key);
        key = frame.parent === undefined ? undefined : String(frame.parent);
      }
      stackCache.set(leaf, stack);
    }
    return stack;
  };
  const js = profile.samples
    .map((sample) => ({
      ns: BigInt(sample.ts) * 1000n,
      tid: Number(sample.tid),
      stack: stackOf(String(sample.sf)),
    }))
    .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  const origin = js[0]!.ns;
  const ms = (ns: bigint) => Number(ns - origin) / 1e6;
  const deltas = js.slice(1).map((s, i) => ms(s.ns) - ms(js[i]!.ns));
  const interval = percentile(deltas, 0.5) || 10;
  // A sample stands for the time until the next one, capped so gaps don't inflate it.
  const weights = js.map((s, i) =>
    i + 1 < js.length
      ? Math.min(ms(js[i + 1]!.ns) - ms(s.ns), 2 * interval)
      : interval
  );
  const frameOf = (key: string) => frames.get(key)!;
  const isIdle = (stack: string[]) =>
    stack.every((key) => frameOf(key)?.kind === 'root');
  const jsThread = (() => {
    const counts = new Map<number, number>();
    for (const s of js) counts.set(s.tid, (counts.get(s.tid) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  })();

  type Acc = {
    function: string;
    self: number;
    total: number;
    samples: number;
    lines: Map<string, number>;
    unknown: number;
    location: string | null;
    frame: SymbolicatedFrame;
  };
  const definition = (frame: SymbolicatedFrame) =>
    frame.source
      ? `${source(frame)}:${frame.functionLine ?? frame.line}`
      : null;
  const functions = new Map<string, Acc>();
  const leafFrames = new Map<string, number>();
  let busyMs = 0;
  let idleMs = 0;
  let gcMs = 0;
  // Nearest JS frame from the leaf: builtins are charged to the JS function calling them.
  const owner = (stack: string[]) =>
    stack.find((key) => frameOf(key)?.kind === 'js') ??
    stack.find((key) => frameOf(key)?.kind !== 'root');
  const functionKey = (frame: SymbolicatedFrame) =>
    frame.kind === 'js'
      ? `${frame.functionId}\0${frame.source ?? ''}`
      : frame.name;
  js.forEach((sample, i) => {
    const weight = weights[i]!;
    if (isIdle(sample.stack)) {
      idleMs += weight;
      return;
    }
    busyMs += weight;
    const leaf = frameOf(sample.stack[0]!);
    if (leaf.kind === 'meta' && /^\[GC/.test(leaf.function)) gcMs += weight;
    leafFrames.set(
      display(leaf),
      (leafFrames.get(display(leaf)) ?? 0) + weight
    );
    const ownerKey = owner(sample.stack);
    const seen = new Set<string>();
    for (const key of sample.stack) {
      const frame = frameOf(key);
      if (frame.kind === 'root') continue;
      const id = functionKey(frame);
      let acc = functions.get(id);
      if (!acc) {
        acc = {
          function: frame.function,
          self: 0,
          total: 0,
          samples: 0,
          lines: new Map(),
          unknown: 0,
          location: definition(frame),
          frame,
        };
        functions.set(id, acc);
      }
      if (!seen.has(id)) {
        acc.total += weight;
        seen.add(id);
      }
      if (key === ownerKey) {
        acc.self += weight;
        acc.samples++;
        if (frame.source && !frame.entry) {
          const line = `${source(frame)}:${frame.line}`;
          acc.lines.set(line, (acc.lines.get(line) ?? 0) + weight);
        } else if (frame.kind === 'js') acc.unknown += weight;
      }
    }
  });
  const window = ms(js[js.length - 1]!.ns) + interval;
  const excerpt = (file: string | undefined, line: number) => {
    const text = file ? input.sourceText?.(file) : undefined;
    if (!text || !Number.isSafeInteger(line)) return undefined;
    const lines = text.split('\n');
    const from = Math.max(1, line - 2);
    return lines
      .slice(from - 1, Math.min(lines.length, line + 2))
      .map((code, i) => `${from + i}: ${code}`);
  };
  const topFunctions: FunctionStat[] = topN(functions, (a) => a.self, top)
    .filter(([, a]) => a.self > 0)
    .map(([, a]) => {
      const hotLines = topN(a.lines, (v) => v, 3).map(([location, value]) => ({
        location,
        ms: round(value),
      }));
      const codeLine = Number(
        (hotLines[0]?.location ?? a.location)?.split(':').pop()
      );
      const code = excerpt(a.frame.source, codeLine);
      return {
        function: a.function,
        location: a.location,
        selfMs: round(a.self),
        totalMs: round(a.total),
        selfPct: pct(a.self, busyMs),
        totalPct: pct(a.total, busyMs),
        samples: a.samples,
        hotLines,
        lineUnknownMs: round(a.unknown),
        ...(code ? { code } : {}),
      };
    });

  // --- Native samples ---
  const offset = manifest?.clockAnchors?.[0]
    ? BigInt(manifest.clockAnchors[0].boottimeNs) -
      BigInt(manifest.clockAnchors[0].monotonicNs)
    : 0n;
  let nativeSamples: {
    mono: bigint;
    tid: number;
    leaf: { frame: string; library: string };
  }[] = [];
  let skippedNativeSamples: Record<string, number> = {};
  let nativeFrequencyHz: number | null = null;
  let nativeRecordsLost = 0;
  if (input.nativeTrace) {
    const inspected = inspectNativeTrace(input.nativeTrace);
    nativeFrequencyHz = inspected.samplingFrequencyHz ?? null;
    nativeRecordsLost = inspected.kernelRecordsLost;
    const decoded = decodeStackSamples(input.nativeTrace);
    skippedNativeSamples = decoded.skipped;
    nativeSamples = decoded.samples
      .filter((s) => !manifest || Number(s.pid) === Number(manifest.pid))
      .map((s) => ({
        mono: s.clock === 6 ? s.timestamp - offset : s.timestamp,
        tid: Number(s.tid),
        leaf: {
          frame: s.frames[0]!.name,
          library: libraryName(s.frames[0]!.file),
        },
      }));
  }
  const leafKey = (leaf: { frame: string; library: string }) =>
    `${leaf.frame}\0${leaf.library}`;
  const countLeaves = (list: typeof nativeSamples) => {
    const counts = new Map<string, number>();
    for (const s of list)
      counts.set(leafKey(s.leaf), (counts.get(leafKey(s.leaf)) ?? 0) + 1);
    return counts;
  };
  const splitLeaf = (key: string) => {
    const [frame, library] = key.split('\0');
    return { frame: frame!, library: library! };
  };
  const nativeOnJs = (from: bigint, to: bigint) =>
    nativeSamples.filter(
      (s) => s.tid === jsThread && s.mono >= from && s.mono <= to
    );
  const hermesEnd = js[js.length - 1]!.ns;
  const overlappingNativeSamples = nativeSamples.filter(
    (s) => s.mono >= origin && s.mono <= hermesEnd
  ).length;

  // --- Long tasks: runs of busy JS samples without idle gaps ---
  const longTasks: LongTask[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const first = js[run[0]!]!;
    const last = js[run[run.length - 1]!]!;
    const durationMs =
      ms(last.ns) - ms(first.ns) + weights[run[run.length - 1]!]!;
    if (durationMs >= input.longTaskMs) {
      const owners = new Map<
        string,
        { frame: SymbolicatedFrame; ms: number; lines: Map<string, number> }
      >();
      const stacks = new Map<string, number>();
      for (const index of run) {
        const sample = js[index]!;
        const key = owner(sample.stack);
        if (key) {
          const frame = frameOf(key);
          const id = functionKey(frame);
          const entry = owners.get(id) ?? { frame, ms: 0, lines: new Map() };
          entry.ms += weights[index]!;
          if (frame.source && !frame.entry) {
            const line = `${source(frame)}:${frame.line}`;
            entry.lines.set(
              line,
              (entry.lines.get(line) ?? 0) + weights[index]!
            );
          }
          owners.set(id, entry);
        }
        stacks.set(
          sample.stack[0]!,
          (stacks.get(sample.stack[0]!) ?? 0) + weights[index]!
        );
      }
      const heaviest = topN(stacks, (v) => v, 1)[0]?.[0];
      const startNs = first.ns;
      const endNs =
        last.ns + BigInt(Math.round(weights[run[run.length - 1]!]! * 1e6));
      longTasks.push({
        startMs: round(ms(first.ns)),
        durationMs: round(durationMs),
        samples: run.length,
        topFunctions: topN(owners, (v) => v.ms, 5).map(([, v]) => ({
          function: v.frame.function,
          location: definition(v.frame),
          hotLine: topN(v.lines, (value) => value, 1)[0]?.[0] ?? null,
          ms: round(v.ms),
        })),
        heaviestStack: heaviest
          ? stackOf(heaviest)
              .filter((key) => frameOf(key).kind !== 'root')
              .map((key) => display(frameOf(key)))
              .reverse()
          : [],
        nativeOnJsThread: topN(
          countLeaves(nativeOnJs(startNs, endNs)),
          (v) => v,
          5
        ).map(([key, samples]) => ({ ...splitLeaf(key), samples })),
      });
    }
    run = [];
  };
  // The sampler keeps sampling an idle JS thread ([root] samples), so a task ends at the
  // first idle sample. Busy threads delay the sampler; only a long gap also ends a task.
  const maxGapMs = Math.max(100, 5 * interval);
  js.forEach((sample, i) => {
    const previous = run[run.length - 1];
    if (
      isIdle(sample.stack) ||
      (previous !== undefined &&
        ms(sample.ns) - ms(js[previous]!.ns) > maxGapMs)
    )
      flush();
    if (!isIdle(sample.stack)) run.push(i);
  });
  flush();

  // --- Native summary ---
  const threadCounts = new Map<number, number>();
  for (const s of nativeSamples)
    threadCounts.set(s.tid, (threadCounts.get(s.tid) ?? 0) + 1);
  const libraryCounts = new Map<string, number>();
  for (const s of nativeSamples)
    libraryCounts.set(
      s.leaf.library,
      (libraryCounts.get(s.leaf.library) ?? 0) + 1
    );
  const pid = manifest ? Number(manifest.pid) : null;

  // --- Quality warnings ---
  const requestedFrequencyHz =
    manifest?.requestedOptions?.samplingFrequencyHz ?? null;
  if (manifest && !input.nativeTrace)
    warnings.push(
      `No native profile (nativeStatus: ${manifest.nativeStatus}${
        manifest.nativeError ? `, ${manifest.nativeError}` : ''
      }); JS-only analysis`
    );
  if (
    nativeFrequencyHz !== null &&
    requestedFrequencyHz !== null &&
    nativeFrequencyHz !== requestedFrequencyHz
  )
    warnings.push(
      `Android clamped native sampling to ${nativeFrequencyHz} Hz (requested ${requestedFrequencyHz} Hz)`
    );
  if (nativeRecordsLost)
    warnings.push(
      `${nativeRecordsLost} native sample records were lost by the kernel buffer`
    );
  const skippedCount = Object.values(skippedNativeSamples).reduce(
    (a, b) => a + b,
    0
  );
  if (skippedCount)
    warnings.push(
      `${skippedCount} native samples were skipped: ${JSON.stringify(
        skippedNativeSamples
      )}`
    );
  if (input.nativeTrace && !overlappingNativeSamples)
    warnings.push(
      'No native samples overlap the JS samples (e.g. a startup recording adopted late)'
    );
  if (input.unmappedFrames)
    warnings.push(`${input.unmappedFrames} JS frames could not be mapped`);
  if (js.length < 50)
    warnings.push(
      `Only ${js.length} JS samples; record longer for stable results`
    );

  const nativeTotal = nativeSamples.length;
  return {
    version: 1,
    session: {
      id: manifest?.sessionId ?? null,
      packageName: manifest?.packageName ?? null,
      pid,
      androidApiLevel: manifest?.androidApiLevel ?? null,
      nativeStatus: manifest?.nativeStatus ?? null,
      nativeError: manifest?.nativeError ?? null,
    },
    quality: {
      jsSamples: js.length,
      jsIntervalMs: {
        median: round(interval, 2),
        p95: round(percentile(deltas, 0.95), 2),
      },
      nativeSamples: nativeTotal,
      requestedFrequencyHz,
      nativeFrequencyHz,
      nativeRecordsLost,
      skippedNativeSamples,
      overlappingNativeSamples,
      symbolicatedFrames: input.symbolicatedFrames,
      unmappedFrames: input.unmappedFrames,
      warnings,
    },
    js: {
      windowMs: round(window),
      busyMs: round(busyMs),
      idleMs: round(idleMs),
      gcMs: round(gcMs),
      topFunctions,
      topLeafFrames: topN(leafFrames, (v) => v, top).map(([frame, value]) => ({
        frame,
        ms: round(value),
        pct: pct(value, busyMs),
      })),
      longTasks,
    },
    native: {
      jsThreadId: jsThread,
      threads: topN(threadCounts, (v) => v, top).map(([id, samples]) => {
        return {
          tid: id,
          label: id === jsThread ? 'JS thread' : id === pid ? 'main' : 'thread',
          samples,
          pct: pct(samples, nativeTotal),
        };
      }),
      topFrames: topN(countLeaves(nativeSamples), (v) => v, top).map(
        ([key, samples]) => ({
          ...splitLeaf(key),
          samples,
          pct: pct(samples, nativeTotal),
        })
      ),
      libraries: topN(libraryCounts, (v) => v, top).map(
        ([library, samples]) => ({
          library,
          samples,
          pct: pct(samples, nativeTotal),
        })
      ),
      jsThreadTopFrames: topN(
        countLeaves(nativeSamples.filter((s) => s.tid === jsThread)),
        (v) => v,
        top
      ).map(([key, samples]) => ({ ...splitLeaf(key), samples })),
    },
  };
}

const table = (header: string[], rows: (string | number)[][]) =>
  rows.length
    ? [
        `| ${header.join(' | ')} |`,
        `|${header.map(() => '---').join('|')}|`,
        ...rows.map(
          (row) =>
            `| ${row
              .map((cell) => String(cell).replace(/\|/g, '\\|'))
              .join(' | ')} |`
        ),
      ].join('\n')
    : '_none_';

export function renderAnalysis(report: AnalysisReport): string {
  const q = report.quality;
  const lines = [
    `# Profile analysis${report.session.id ? ` — ${report.session.id}` : ''}`,
    '',
    `**Capture:** ${q.jsSamples} JS samples (every ~${q.jsIntervalMs.median} ms) over ${report.js.windowMs} ms` +
      (q.nativeSamples
        ? ` · ${q.nativeSamples} native samples${
            q.nativeFrequencyHz ? ` at ${q.nativeFrequencyHz} Hz` : ''
          }`
        : ''),
    `**JS thread:** busy ${report.js.busyMs} ms (${pct(
      report.js.busyMs,
      report.js.windowMs
    )}%), GC ${report.js.gcMs} ms, idle ${report.js.idleMs} ms`,
  ];
  if (q.warnings.length)
    lines.push('', '**Warnings:**', ...q.warnings.map((w) => `- ${w}`));
  lines.push(
    '',
    `## Long JS tasks (${report.js.longTasks.length})`,
    '',
    table(
      ['start ms', 'duration ms', 'top functions', 'native on JS thread'],
      report.js.longTasks.map((task) => [
        task.startMs,
        task.durationMs,
        task.topFunctions
          .slice(0, 3)
          .map(
            (f) =>
              `${f.function}${
                f.hotLine ?? f.location ? ` (${f.hotLine ?? f.location})` : ''
              } ${f.ms} ms`
          )
          .join('; '),
        task.nativeOnJsThread
          .slice(0, 3)
          .map((n) => `${n.frame} [${n.library}] ×${n.samples}`)
          .join('; '),
      ])
    ),
    '',
    '## Top JS functions (self time, incl. builtins they call)',
    '',
    table(
      ['function', 'defined at', 'hot lines', 'self ms', 'self %', 'total ms'],
      report.js.topFunctions.map((f) => [
        f.function,
        f.location ?? '',
        [
          ...f.hotLines.map(
            (h) => `${h.location.split(':').pop()} (${h.ms} ms)`
          ),
          ...(f.lineUnknownMs ? [`unknown line (${f.lineUnknownMs} ms)`] : []),
        ].join(', '),
        f.selfMs,
        f.selfPct,
        f.totalMs,
      ])
    ),
    '',
    '## Top leaf frames',
    '',
    table(
      ['frame', 'ms', '%'],
      report.js.topLeafFrames.map((f) => [f.frame, f.ms, f.pct])
    )
  );
  if (report.quality.nativeSamples) {
    lines.push(
      '',
      '## Native',
      '',
      table(
        ['thread', 'samples', '%'],
        report.native.threads.map((t) => [
          `${t.tid} (${t.label})`,
          t.samples,
          t.pct,
        ])
      ),
      '',
      table(
        ['library', 'samples', '%'],
        report.native.libraries.map((l) => [l.library, l.samples, l.pct])
      ),
      '',
      '### Top native frames on the JS thread',
      '',
      table(
        ['frame', 'library', 'samples'],
        report.native.jsThreadTopFrames.map((f) => [
          f.frame,
          f.library,
          f.samples,
        ])
      )
    );
  }
  return lines.join('\n') + '\n';
}
