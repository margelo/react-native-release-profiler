import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SourceMapConsumer } from 'source-map';
import { ProfilerError, readInputFile } from './errors';
import { libraryName } from './folded';
import {
  loadSession,
  validateSession,
  type HermesProfile,
  type ProfileSessionManifest,
} from './mergeProfiles';
import { inspectNativeTrace, nativeCoverage } from './perfettoProto';
import {
  readHermesProfile,
  symbolicateFrames,
  type SymbolicatedFrame,
} from './symbolicate';
import { decodeStackSamples } from './traceSamples';

/** Self time of one JS function (or builtin/meta frame with no JS caller). */
export interface FunctionTime {
  /** Identity for matching a function across reports and builds: name, file name and
   * definition line. Unlike `location`, it does not depend on where analyze ran. */
  id: string;
  function: string;
  /** `file:line` where the function is defined, relative to the project root. */
  location: string | null;
  /** Time with this function at the top of the stack, including builtins it called directly. */
  selfMs: number;
  /** Time with this function anywhere on the stack. */
  totalMs: number;
  samples: number;
  /** Stretches of consecutive samples with this function on top. Periodic sampling misjudges
   * each stretch by up to about one interval, so sampling error grows with runs, not samples. */
  runs: number;
}

export interface FunctionStat extends FunctionTime {
  selfPct: number;
  totalPct: number;
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
  /** `location` is the definition; `hotLine` the hottest statement in this task, or null when
   * fewer than half of the function's time here has a known line (`lineUnknownMs`). */
  topFunctions: {
    function: string;
    location: string | null;
    hotLine: string | null;
    hotLineMs: number;
    lineUnknownMs: number;
    ms: number;
  }[];
  /** Most frequent stack in the task, outermost first. */
  heaviestStack: string[];
  /** Most frequent native leaf frames sampled on the JS thread during the task. */
  nativeOnJsThread: { frame: string; library: string; samples: number }[];
  /** All native samples on the JS thread during the task, and their libraries. */
  nativeOnJsThreadSamples: number;
  nativeLibrariesOnJsThread: { library: string; samples: number }[];
}

export interface NativeBreakdown {
  threads: { tid: number; label: string; samples: number; pct: number }[];
  topFrames: {
    frame: string;
    library: string;
    samples: number;
    pct: number;
  }[];
  libraries: { library: string; samples: number; pct: number }[];
}

export interface AnalysisReport {
  version: 1;
  /** How the report was made; compare checks that both sides match. */
  settings: {
    longTaskMs: number;
    top: number;
    /** Identifies the JS build (SHA-1 of the source map). */
    sourceMapSha1: string | null;
  };
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
    /** Hermes threads other than the JS thread; their samples are not in `js`. */
    otherJsThreads: { tid: number; samples: number }[];
    /** Native stack samples of the app process over the whole capture. */
    nativeSamples: number;
    requestedFrequencyHz: number | null;
    nativeFrequencyHz: number | null;
    nativeRecordsLost: number;
    skippedNativeSamples: Record<string, number>;
    overlappingNativeSamples: number;
    symbolicatedFrames: number;
    unmappedFrames: number;
    /** The profile has source positions (debug build), not bytecode offsets. */
    debugBuild: boolean;
    warnings: string[];
  };
  js: {
    windowMs: number;
    busyMs: number;
    /** Stretches of consecutive busy samples (sampling error of busyMs grows with these). */
    busyRuns: number;
    idleMs: number;
    gcMs: number;
    gcRuns: number;
    /** JS functions by self time (builtins they call count towards them), top `settings.top`. */
    topFunctions: FunctionStat[];
    /** Every function with self time, for comparing reports. */
    functions: FunctionTime[];
    /** Leaf frames as sampled, including builtins such as `[Native] jsonParse`. */
    topLeafFrames: { frame: string; ms: number; pct: number }[];
    longTasks: LongTask[];
  };
  native: NativeBreakdown & {
    jsThreadId: number | null;
    /** Native samples from JS start on (the denominator of the percentages). */
    samples: number;
    jsThreadTopFrames: { frame: string; library: string; samples: number }[];
    /** Native samples before JS sampling started (startup), kept out of the totals above:
     * `spanMs` from the first to the last of them, `gapToJsMs` from the last to JS start. */
    beforeJs:
      | (NativeBreakdown & {
          samples: number;
          spanMs: number;
          gapToJsMs: number;
        })
      | null;
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
const fileName = (file: string) => file.split(/[\\/]/).pop() || file;

/** `name@file:line` from a function name and its `file:line` definition. */
export const functionIdentity = (name: string, location: string | null) =>
  location ? `${name}@${fileName(location)}` : name;

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
  const profile = readHermesProfile(hermesPath);
  if (
    !profile.stackFrames ||
    !Array.isArray(profile.samples) ||
    !profile.samples.length
  )
    throw new ProfilerError(
      'E_HERMES_PROFILE',
      'Hermes profile has no samples or stack frames'
    );
  const sourceMapText = fs.readFileSync(options.sourceMap, 'utf8');
  const symbolicated = await symbolicateFrames(profile, sourceMapText);
  // The consumer resolves sources the way symbolication names them (sourceRoot,
  // normalisation, indexed maps), so excerpts are found for every mapped frame.
  const consumer = await new SourceMapConsumer(JSON.parse(sourceMapText));
  try {
    const report = analyzeProfiles({
      profile,
      frames: symbolicated.frames,
      symbolicatedFrames: symbolicated.symbolicatedFrames,
      unmappedFrames: symbolicated.unmappedFrames,
      manifest,
      nativeTrace: nativePath
        ? readInputFile(
            nativePath,
            'E_TRACE_FORMAT',
            'native trace',
            'Re-pull the whole session directory, or analyze --profile <hermes.cpuprofile> for JS only'
          )
        : undefined,
      longTaskMs: options.longTaskMs ?? 50,
      top: options.top ?? 15,
      root: options.root ?? process.cwd(),
      sourceMapSha1: crypto
        .createHash('sha1')
        .update(sourceMapText)
        .digest('hex'),
      sourceText: (file) => {
        try {
          return consumer.sourceContentFor(file, true) ?? undefined;
        } catch {
          return undefined;
        }
      },
    });
    if (symbolicated.unverifiedFrames)
      report.quality.warnings.push(
        `${symbolicated.unverifiedFrames} JS frames have no bytecode address (profile saved by an older \`--raw\` pull), so the source map could not be verified against them; use the map of the exact build that recorded the profile`
      );
    return report;
  } finally {
    consumer.destroy();
  }
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
  sourceMapSha1?: string;
  /** Original source text (from the map's sourcesContent) for code excerpts. */
  sourceText?: (source: string) => string | undefined;
}): AnalysisReport {
  const { profile, frames, manifest, top, root } = input;
  const warnings: string[] = [];
  // A session whose parts don't belong together fails here, as it does in merge.
  const session = manifest
    ? validateSession(manifest, profile, input.nativeTrace)
    : undefined;
  const source = (frame: SymbolicatedFrame) => {
    if (!frame.source) return null;
    const relative = path.isAbsolute(frame.source)
      ? path.relative(root, frame.source)
      : frame.source;
    return relative.startsWith('..') ? frame.source : relative;
  };
  // Hermes reports the innermost interpreted frame at its function start: bytecode offset 0
  // (release) or, in debug profiles, the function's own start position. That is not a line
  // that executed, so it is shown as the definition and counted as an unknown line.
  const isEntry = (key: string) => {
    if (frames.get(key)?.entry) return true;
    const raw = profile.stackFrames[key];
    return (
      raw?.funcVirtAddr === undefined &&
      raw?.funcLine !== undefined &&
      raw.line !== undefined &&
      Number(raw.line) === Number(raw.funcLine) &&
      Number(raw.column) === Number(raw.funcColumn)
    );
  };
  const definitionLine = (frame: SymbolicatedFrame) =>
    frame.functionLine ?? frame.line;
  const display = (key: string) => {
    const frame = frameOf(key);
    if (!frame.source) return frame.name;
    return isEntry(key)
      ? `${frame.function} (defined at ${source(frame)}:${definitionLine(
          frame
        )})`
      : `${frame.function} (${source(frame)}:${frame.line})`;
  };

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
        if (!frame)
          throw new ProfilerError(
            'E_HERMES_PROFILE',
            `Missing Hermes stack frame ${key}`
          );
        if (seen.has(key))
          throw new ProfilerError(
            'E_HERMES_PROFILE',
            'Cycle in Hermes stack frame parents'
          );
        seen.add(key);
        stack.push(key);
        key = frame.parent === undefined ? undefined : String(frame.parent);
      }
      stackCache.set(leaf, stack);
    }
    return stack;
  };
  const allSamples = profile.samples.map((sample) => ({
    ns: BigInt(sample.ts) * 1000n,
    tid: Number(sample.tid),
    stack: stackOf(String(sample.sf)),
  }));
  // Each Hermes runtime thread is its own timeline; interleaving another thread's samples
  // would halve weights and end busy runs at its idle samples. Analyze the JS thread.
  const threadSamples = new Map<number, number>();
  for (const s of allSamples)
    threadSamples.set(s.tid, (threadSamples.get(s.tid) ?? 0) + 1);
  const jsThread = [...threadSamples].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0]
  )[0]![0];
  const otherJsThreads = [...threadSamples]
    .filter(([tid]) => tid !== jsThread)
    .map(([tid, samples]) => ({ tid, samples }));
  const others = otherJsThreads.map((t) => `tid ${t.tid}: ${t.samples}`);
  if (others.length)
    warnings.push(
      `Hermes samples of other threads (${others.join(', ')}) are not ` +
        `included; this analysis covers JS thread ${jsThread}`
    );
  const js = allSamples
    .filter((s) => s.tid === jsThread)
    .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  const origin = js[0]!.ns;
  const ms = (ns: bigint) => Number(ns - origin) / 1e6;
  const deltas = js.slice(1).map((s, i) => ms(s.ns) - ms(js[i]!.ns));
  const interval = percentile(deltas, 0.5) || 10;
  // A sample stands for the time halfway to its neighbours (gaps capped so a stalled
  // sampler doesn't inflate it): the first busy sample comes up to a gap after a task
  // starts and the next idle one up to a gap after it ends, so midpoints are unbiased.
  // The recording starts at the first sample; the last one stands for one interval.
  const half = (gap: number) => Math.min(gap, 2 * interval) / 2;
  const lead = js.map((_, i) => (i ? half(deltas[i - 1]!) : 0));
  const trail = js.map((_, i) =>
    i < deltas.length ? half(deltas[i]!) : interval
  );
  const weights = js.map((_, i) => lead[i]! + trail[i]!);
  const frameOf = (key: string) => frames.get(key)!;
  const isIdle = (stack: string[]) =>
    stack.every((key) => frameOf(key)?.kind === 'root');

  type Acc = {
    function: string;
    self: number;
    total: number;
    samples: number;
    runs: number;
    lines: Map<string, number>;
    unknown: number;
    location: string | null;
    frame: SymbolicatedFrame;
  };
  const definition = (frame: SymbolicatedFrame) =>
    frame.source ? `${source(frame)}:${definitionLine(frame)}` : null;
  // Label a function after its frame nearest the definition, so the name and location
  // don't depend on which of its frames happened to be sampled first.
  const nearer = (a: SymbolicatedFrame, b: SymbolicatedFrame) =>
    (a.line ?? Infinity) - (b.line ?? Infinity) ||
    (a.column ?? Infinity) - (b.column ?? Infinity) ||
    (a.function < b.function ? -1 : a.function > b.function ? 1 : 0);
  const functions = new Map<string, Acc>();
  const leafFrames = new Map<string, number>();
  let busyMs = 0;
  let busyRuns = 0;
  let idleMs = 0;
  let gcMs = 0;
  let gcRuns = 0;
  // Nearest JS frame from the leaf: builtins are charged to the JS function calling them.
  const owner = (stack: string[]) =>
    stack.find((key) => frameOf(key)?.kind === 'js') ??
    stack.find((key) => frameOf(key)?.kind !== 'root');
  const functionKey = (frame: SymbolicatedFrame) =>
    frame.kind === 'js'
      ? `${frame.functionId}\0${frame.source ?? ''}`
      : frame.name;
  const lineOf = (key: string) => {
    const frame = frameOf(key);
    return frame.source && !isEntry(key)
      ? `${source(frame)}:${frame.line}`
      : null;
  };
  let previousOwner: string | null = null;
  let previousBusy = false;
  let previousGc = false;
  js.forEach((sample, i) => {
    const weight = weights[i]!;
    if (isIdle(sample.stack)) {
      idleMs += weight;
      previousOwner = null;
      previousBusy = previousGc = false;
      return;
    }
    busyMs += weight;
    if (!previousBusy) busyRuns++;
    previousBusy = true;
    const leaf = frameOf(sample.stack[0]!);
    const gc = leaf.kind === 'meta' && /^\[GC/.test(leaf.function);
    if (gc) {
      gcMs += weight;
      if (!previousGc) gcRuns++;
    }
    previousGc = gc;
    const leafName = display(sample.stack[0]!);
    leafFrames.set(leafName, (leafFrames.get(leafName) ?? 0) + weight);
    const ownerKey = owner(sample.stack);
    const seen = new Set<string>();
    let ownerId: string | null = null;
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
          runs: 0,
          lines: new Map(),
          unknown: 0,
          location: definition(frame),
          frame,
        };
        functions.set(id, acc);
      } else if (nearer(frame, acc.frame) < 0) {
        acc.function = frame.function;
        acc.location = definition(frame);
        acc.frame = frame;
      }
      if (!seen.has(id)) {
        acc.total += weight;
        seen.add(id);
      }
      if (key === ownerKey) {
        ownerId = id;
        acc.self += weight;
        acc.samples++;
        if (previousOwner !== id) acc.runs++;
        const line = lineOf(key);
        if (line) acc.lines.set(line, (acc.lines.get(line) ?? 0) + weight);
        else if (frame.kind === 'js') acc.unknown += weight;
      }
    }
    previousOwner = ownerId;
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
  const ranked = [...functions]
    .filter(([, a]) => a.self > 0)
    .sort(
      (a, b) =>
        b[1].self - a[1].self ||
        (a[1].location ?? '').localeCompare(b[1].location ?? '')
    );
  const functionTime = (a: Acc): FunctionTime => ({
    id: functionIdentity(a.function, a.location),
    function: a.function,
    location: a.location,
    selfMs: round(a.self),
    totalMs: round(a.total),
    samples: a.samples,
    runs: a.runs,
  });
  const topFunctions: FunctionStat[] = ranked.slice(0, top).map(([, a]) => {
    const hotLines = topN(a.lines, (v) => v, 3).map(([location, value]) => ({
      location,
      ms: round(value),
    }));
    const codeLine = Number(
      (hotLines[0]?.location ?? a.location)?.split(':').pop()
    );
    const code = excerpt(a.frame.source, codeLine);
    return {
      ...functionTime(a),
      selfPct: pct(a.self, busyMs),
      totalPct: pct(a.total, busyMs),
      hotLines,
      lineUnknownMs: round(a.unknown),
      ...(code ? { code } : {}),
    };
  });

  // --- Native samples ---
  const offset = session?.boottimeOffsetNs ?? 0n;
  let nativeSamples: {
    mono: bigint;
    tid: number;
    leaf: { frame: string; library: string };
  }[] = [];
  let skippedNativeSamples: Record<string, number> = {};
  let nativeFrequencyHz: number | null = null;
  let nativeRecordsLost = 0;
  let coverageWarnings: string[] = [];
  const nativeTrace =
    session?.nativeSamples === 0 ? undefined : input.nativeTrace;
  if (input.nativeTrace && !nativeTrace)
    warnings.push(
      'The native trace has no stack samples for this app (sampling failed or Android redacted them); JS-only analysis'
    );
  if (nativeTrace) {
    const inspected = inspectNativeTrace(nativeTrace);
    // Same buffer-overflow / early-stop / late-start checks as pull-merge.
    if (manifest)
      coverageWarnings = nativeCoverage(inspected, manifest).warnings;
    nativeFrequencyHz = inspected.samplingFrequencyHz ?? null;
    nativeRecordsLost = inspected.kernelRecordsLost;
    const decoded = decodeStackSamples(nativeTrace);
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
  const countLibraries = (list: typeof nativeSamples) => {
    const counts = new Map<string, number>();
    for (const s of list)
      counts.set(s.leaf.library, (counts.get(s.leaf.library) ?? 0) + 1);
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
  const nsAt = (msValue: number) => origin + BigInt(Math.round(msValue * 1e6));

  // --- Long tasks: runs of busy JS samples without idle gaps ---
  const longTasks: LongTask[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const firstIndex = run[0]!;
    const lastIndex = run[run.length - 1]!;
    const startMs = ms(js[firstIndex]!.ns) - lead[firstIndex]!;
    const endMs = ms(js[lastIndex]!.ns) + trail[lastIndex]!;
    const durationMs = endMs - startMs;
    if (durationMs >= input.longTaskMs) {
      const owners = new Map<
        string,
        { ms: number; lines: Map<string, number> }
      >();
      const stacks = new Map<string, number>();
      for (const index of run) {
        const sample = js[index]!;
        const key = owner(sample.stack);
        if (key) {
          const id = functionKey(frameOf(key));
          const entry = owners.get(id) ?? { ms: 0, lines: new Map() };
          entry.ms += weights[index]!;
          const line = lineOf(key);
          if (line)
            entry.lines.set(
              line,
              (entry.lines.get(line) ?? 0) + weights[index]!
            );
          owners.set(id, entry);
        }
        stacks.set(
          sample.stack[0]!,
          (stacks.get(sample.stack[0]!) ?? 0) + weights[index]!
        );
      }
      const heaviest = topN(stacks, (v) => v, 1)[0]?.[0];
      const onJs = nativeOnJs(nsAt(startMs), nsAt(endMs));
      longTasks.push({
        startMs: round(startMs),
        durationMs: round(durationMs),
        samples: run.length,
        topFunctions: topN(owners, (v) => v.ms, 5).map(([id, v]) => {
          const acc = functions.get(id)!;
          const [hot, hotMs = 0] = topN(v.lines, (value) => value, 1)[0] ?? [];
          const known = [...v.lines.values()].reduce((a, b) => a + b, 0);
          return {
            function: acc.function,
            location: acc.location,
            hotLine: hot !== undefined && known >= v.ms / 2 ? hot : null,
            hotLineMs: round(hotMs),
            lineUnknownMs: round(v.ms - known),
            ms: round(v.ms),
          };
        }),
        heaviestStack: heaviest
          ? stackOf(heaviest)
              .filter((key) => frameOf(key).kind !== 'root')
              .map(display)
              .reverse()
          : [],
        nativeOnJsThread: topN(countLeaves(onJs), (v) => v, 5).map(
          ([key, samples]) => ({ ...splitLeaf(key), samples })
        ),
        nativeOnJsThreadSamples: onJs.length,
        nativeLibrariesOnJsThread: topN(
          countLibraries(onJs),
          (v) => v,
          Infinity
        ).map(([library, samples]) => ({ library, samples })),
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

  // --- Native summary: from JS start on, and startup (before JS) separately ---
  const pid = manifest ? Number(manifest.pid) : null;
  // Hermes sampling starts at the hermesStart boundary; native samples before it are startup.
  const hermesStart = String(manifest?.boundaries?.hermesStart?.monotonicNs);
  const jsStart =
    /^\d+$/.test(hermesStart) && BigInt(hermesStart) < origin
      ? BigInt(hermesStart)
      : origin;
  const label = (tid: number) =>
    tid === jsThread ? 'JS thread' : tid === pid ? 'main' : 'thread';
  const breakdown = (list: typeof nativeSamples): NativeBreakdown => {
    const threadCounts = new Map<number, number>();
    for (const s of list)
      threadCounts.set(s.tid, (threadCounts.get(s.tid) ?? 0) + 1);
    return {
      threads: topN(threadCounts, (v) => v, top).map(([id, samples]) => ({
        tid: id,
        label: label(id),
        samples,
        pct: pct(samples, list.length),
      })),
      topFrames: topN(countLeaves(list), (v) => v, top).map(
        ([key, samples]) => ({
          ...splitLeaf(key),
          samples,
          pct: pct(samples, list.length),
        })
      ),
      libraries: topN(countLibraries(list), (v) => v, top).map(
        ([library, samples]) => ({
          library,
          samples,
          pct: pct(samples, list.length),
        })
      ),
    };
  };
  const startup = nativeSamples.filter((s) => s.mono < jsStart);
  const fromJs = nativeSamples.filter((s) => s.mono >= jsStart);
  const startupTimes = startup
    .map((s) => s.mono)
    .sort((x, y) => (x < y ? -1 : 1));
  const startupMs = (from: bigint | undefined, to: bigint | undefined) =>
    from === undefined || to === undefined ? 0 : round(Number(to - from) / 1e6);

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
  if (nativeTrace && !overlappingNativeSamples)
    warnings.push(
      'No native samples overlap the JS samples (e.g. a startup recording adopted late)'
    );
  warnings.push(...coverageWarnings);
  if (input.unmappedFrames)
    warnings.push(`${input.unmappedFrames} JS frames could not be mapped`);
  if (js.length < 50)
    warnings.push(
      `Only ${js.length} JS samples; record longer for stable results`
    );
  const jsFrames = Object.values(profile.stackFrames).filter(
    (frame) => frame.category === 'JavaScript'
  );
  const debugBuild =
    jsFrames.filter(
      (frame) => frame.funcVirtAddr === undefined && frame.line !== undefined
    ).length >
    jsFrames.length / 2;
  if (debugBuild)
    warnings.push(
      'Debug build (the profile has source positions): JS runs unoptimized with dev checks, so timings are not representative; profile a release build'
    );

  return {
    version: 1,
    settings: {
      longTaskMs: input.longTaskMs,
      top,
      sourceMapSha1: input.sourceMapSha1 ?? null,
    },
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
      otherJsThreads,
      nativeSamples: nativeSamples.length,
      requestedFrequencyHz,
      nativeFrequencyHz,
      nativeRecordsLost,
      skippedNativeSamples,
      overlappingNativeSamples,
      symbolicatedFrames: input.symbolicatedFrames,
      unmappedFrames: input.unmappedFrames,
      debugBuild,
      warnings,
    },
    js: {
      windowMs: round(window),
      busyMs: round(busyMs),
      busyRuns,
      idleMs: round(idleMs),
      gcMs: round(gcMs),
      gcRuns,
      topFunctions,
      functions: ranked.map(([, a]) => functionTime(a)),
      topLeafFrames: topN(leafFrames, (v) => v, top).map(([frame, value]) => ({
        frame,
        ms: round(value),
        pct: pct(value, busyMs),
      })),
      longTasks,
    },
    native: {
      jsThreadId: jsThread,
      samples: fromJs.length,
      ...breakdown(fromJs),
      jsThreadTopFrames: topN(
        countLeaves(fromJs.filter((s) => s.tid === jsThread)),
        (v) => v,
        top
      ).map(([key, samples]) => ({ ...splitLeaf(key), samples })),
      beforeJs: startup.length
        ? {
            samples: startup.length,
            spanMs: startupMs(startupTimes[0], startupTimes.at(-1)),
            gapToJsMs: startupMs(startupTimes.at(-1), jsStart),
            ...breakdown(startup),
          }
        : null,
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

const nativeTables = (breakdown: NativeBreakdown) => [
  table(
    ['thread', 'samples', '%'],
    breakdown.threads.map((t) => [`${t.tid} (${t.label})`, t.samples, t.pct])
  ),
  '',
  table(
    ['library', 'samples', '%'],
    breakdown.libraries.map((l) => [l.library, l.samples, l.pct])
  ),
];

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
    `## Long JS tasks (${report.js.longTasks.length}, ≥ ${report.settings.longTaskMs} ms)`,
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
                f.hotLine
                  ? ` (hot line ${f.hotLine})`
                  : f.location
                  ? ` (defined at ${f.location})`
                  : ''
              } ${f.ms} ms`
          )
          .join('; '),
        task.nativeOnJsThreadSamples
          ? `${
              task.nativeOnJsThreadSamples
            } samples: ${task.nativeLibrariesOnJsThread
              .map((l) => `${l.library} ×${l.samples}`)
              .join(', ')}; top ${task.nativeOnJsThread
              .slice(0, 3)
              .map((n) => `${n.frame} ×${n.samples}`)
              .join(', ')}`
          : '',
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
  if (report.native.samples) {
    lines.push(
      '',
      `## Native (${report.native.samples} samples from JS start)`,
      '',
      ...nativeTables(report.native),
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
  const startup = report.native.beforeJs;
  if (startup) {
    lines.push(
      '',
      `## Native before JS started (startup: ${startup.samples} samples over ${startup.spanMs} ms, the last ${startup.gapToJsMs} ms before JS sampling began)`,
      '',
      ...nativeTables(startup),
      '',
      table(
        ['frame', 'library', 'samples'],
        startup.topFrames.map((f) => [f.frame, f.library, f.samples])
      )
    );
  }
  return lines.join('\n') + '\n';
}
