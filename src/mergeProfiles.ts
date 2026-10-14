import fs from 'fs';
import { toSimpleperf } from './simpleperf';
import path from 'path';
import { ProfilerError } from './errors';
import { toFolded } from './folded';
import { symbolicateFrames } from './symbolicate';
import { decodeStackSamples, type StackSample } from './traceSamples';
import {
  bytes,
  concat,
  message,
  inspectNativeTrace,
  nativeCoverage,
  packet,
  uint,
} from './perfettoProto';

export interface ClockAnchor {
  monotonicNs: string;
  boottimeNs: string;
  uncertaintyNs?: string;
}
export { assertSourceMapMatchesProfile } from './symbolicate';

export interface ProfileSessionManifest {
  version: 1;
  packageName?: string;
  androidApiLevel?: number;
  sessionId: string;
  pid: number;
  hermesClock: 'monotonic';
  hermesProfilePath: string;
  nativeProfilePath: string | null;
  nativeStatus: string;
  nativeError?: string | null;
  clockAnchors: ClockAnchor[];
  boundaries?: {
    nativeRequest?: ClockAnchor;
    hermesStart?: ClockAnchor;
    nativeResult?: ClockAnchor;
  };
  requestedOptions?: { samplingFrequencyHz?: number; durationMs?: number };
}
interface Frame {
  name: string;
  category?: string;
  parent?: string | number;
  line?: string | number;
  column?: string | number;
  funcVirtAddr?: string | number;
  offset?: string | number;
  /** Debug (source) profiles: where the function starts in the bundle. */
  funcLine?: string | number;
  funcColumn?: string | number;
}
interface Sample {
  ts: string | number;
  pid: number;
  tid: string | number;
  sf: string | number;
}
export interface HermesProfile {
  stackFrames: Record<string, Frame>;
  samples: Sample[];
}

function integer(value: unknown, label: string): bigint {
  if (
    (typeof value !== 'string' || !/^\d+$/.test(value)) &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new ProfilerError(
      'E_SESSION_MANIFEST',
      `${label} must be a nonnegative integer (use strings for nanoseconds)`
    );
  }
  return BigInt(value as string | number);
}
const abs = (n: bigint) => (n < 0n ? -n : n);

/** Android Hermes steady_clock is CLOCK_MONOTONIC; native Perfetto uses BOOTTIME.
 * Refuse suspend/clock jumps: two endpoints cannot locate a suspend inside a session.
 */
export function createClockMapper(
  anchors: ClockAnchor[]
): (us: string | number) => bigint {
  if (!Array.isArray(anchors) || anchors.length < 2) {
    throw new ProfilerError(
      'E_CLOCK',
      'At least start and stop clock anchors are required'
    );
  }
  const clocks = anchors
    .map((a) => ({
      mono: integer(a.monotonicNs, 'monotonicNs'),
      boot: integer(a.boottimeNs, 'boottimeNs'),
      uncertainty: integer(a.uncertaintyNs ?? '0', 'uncertaintyNs'),
    }))
    .sort((a, b) => (a.mono < b.mono ? -1 : a.mono > b.mono ? 1 : 0));
  const first = clocks[0]!;
  const last = clocks[clocks.length - 1]!;
  const offset = first.boot - first.mono;
  for (const clock of clocks) {
    if (clock.uncertainty > 1000000n)
      throw new ProfilerError(
        'E_CLOCK',
        'Clock calibration uncertainty exceeds 1 ms'
      );
    if (
      abs(clock.boot - clock.mono - offset) >
      first.uncertainty + clock.uncertainty + 100000n
    ) {
      throw new ProfilerError(
        'E_CLOCK',
        'Device suspended or clocks changed during capture; cannot synchronize accurately'
      );
    }
  }
  return (us) => {
    const ns = integer(us, 'Hermes timestamp') * 1000n;
    // Clock anchors bracket enable/disable; allow quantization and scheduling tolerance.
    if (ns < first.mono - 1000000n || ns > last.mono + 1000000n) {
      throw new ProfilerError(
        'E_CLOCK',
        'Hermes samples fall outside session clock anchors; wrong profile or clock domain'
      );
    }
    return ns + offset;
  };
}

/** Append separately identified JS sample packets, not synthetic joined native/JS stacks.
 * This preserves samples (including irregular sampling intervals), not inferred execution durations.
 */
export async function mergeProfileBuffers(
  nativeTrace: Buffer,
  profile: HermesProfile,
  manifest: ProfileSessionManifest,
  sourceMap: string
): Promise<{
  trace: Buffer;
  samples: number;
  nativeSamples: number;
  symbolicatedFrames: number;
  unmappedFrames: number;
  nativeFrequencyHz?: number;
  nativeRecordsLost: number;
  overlappingNativeSamples: number;
  /** Native samples that could not be decoded, by reason. */
  skippedNativeSamples: Record<string, number>;
  /** Native data loss: buffer overflow, sampling started late or stopped early, damage. */
  nativeWarnings: string[];
}> {
  if (
    manifest.version !== 1 ||
    manifest.hermesClock !== 'monotonic' ||
    !manifest.sessionId
  ) {
    throw new ProfilerError(
      'E_SESSION_MANIFEST',
      'Unsupported session manifest version or Hermes clock'
    );
  }
  const pid = Number(integer(manifest.pid, 'pid'));
  if (pid <= 0 || pid > 0x7fffffff)
    throw new ProfilerError('E_SESSION_MANIFEST', 'Invalid session pid');
  if (
    !profile.stackFrames ||
    !Array.isArray(profile.samples) ||
    !profile.samples.length
  ) {
    throw new ProfilerError(
      'E_HERMES_PROFILE',
      'Hermes profile has no samples or stack frames'
    );
  }
  const native = inspectNativeTrace(nativeTrace);
  const { sequence, samplingFrequencyHz, kernelRecordsLost } = native;
  // Appending to a truncated trace would glue the Hermes packets onto its cut-off last
  // packet; keep only the intact packets.
  const intactTrace =
    native.intactBytes < nativeTrace.length
      ? nativeTrace.subarray(0, native.intactBytes)
      : nativeTrace;
  // Validate and count what the exporters can decode, not raw packets.
  const decoded = decodeStackSamples(intactTrace);
  const samplePids = new Set(decoded.samples.map((s) => Number(s.pid)));
  const appSamples = decoded.samples.filter((s) => Number(s.pid) === pid);
  if (samplePids.size && !samplePids.has(pid)) {
    throw new ProfilerError(
      'E_WRONG_NATIVE_TRACE',
      'Native sample PIDs do not match the session; wrong native trace'
    );
  }
  const nativeSamples = appSamples.length;
  if (!nativeSamples) {
    throw new ProfilerError(
      'E_NO_NATIVE_SAMPLES',
      `Native trace contains no stack samples for this app${
        Object.keys(decoded.skipped).length
          ? ` (undecodable: ${JSON.stringify(decoded.skipped)})`
          : ''
      }. ProfilingManager may return success after sampling failed or Android removed sample payloads during redaction; this capture cannot be merged.`
    );
  }
  const mapTime = createClockMapper(manifest.clockAnchors);
  // Android STACK_SAMPLING uses MONOTONIC (3), or BOOTTIME (6). Honor
  // packet/default clock IDs; packet timestamps are not necessarily BOOTTIME.
  const clocks = manifest.clockAnchors
    .map((anchor) => ({
      mono: BigInt(anchor.monotonicNs),
      boot: BigInt(anchor.boottimeNs),
    }))
    .sort((a, b) => (a.mono < b.mono ? -1 : a.mono > b.mono ? 1 : 0));
  const first = clocks[0]!;
  const last = clocks[clocks.length - 1]!;
  // The decoder already skipped samples with other clocks.
  const nativeTimes = appSamples.map((sample) =>
    sample.clock === 3
      ? sample.timestamp + first.boot - first.mono
      : sample.timestamp
  );
  // Require some native coverage during this session, not during Hermes alone:
  // early native samples are useful, and native sampling can continue after stop.
  const nativeRequest = manifest.boundaries?.nativeRequest;
  const captureStart = nativeRequest
    ? integer(nativeRequest.boottimeNs, 'nativeRequest.boottimeNs')
    : first.boot;
  const nativeResult = manifest.boundaries?.nativeResult;
  const resultBoot = nativeResult
    ? integer(nativeResult.boottimeNs, 'nativeResult.boottimeNs')
    : last.boot;
  const captureEnd = resultBoot > last.boot ? resultBoot : last.boot;
  const tolerance = 1000000n;
  if (
    !nativeTimes.some(
      (ts) => ts >= captureStart - tolerance && ts <= captureEnd + tolerance
    )
  ) {
    throw new ProfilerError(
      'E_WRONG_NATIVE_TRACE',
      'Native samples do not overlap session clock anchors; wrong native trace for this session'
    );
  }
  // An adopted startup recording may end before JS sampling starts. That is valid, but
  // the two tracks then never overlap, so report it instead of implying they do.
  const hermesStart = manifest.boundaries?.hermesStart
    ? integer(manifest.boundaries.hermesStart.boottimeNs, 'hermesStart')
    : first.boot;
  const overlappingNativeSamples = nativeTimes.filter(
    (ts) => ts >= hermesStart && ts <= last.boot
  ).length;
  const interned: Buffer[] = [];
  const frameIds = new Map<string, number>();
  // A dedicated mapping identifies JS frames without inventing native addresses.
  interned.push(
    bytes(17, message(uint(1, 1), bytes(2, '[Hermes JavaScript]')))
  );
  interned.push(bytes(19, message(uint(1, 1), uint(7, 1))));
  interned.push(
    bytes(17, message(uint(1, 2), bytes(2, '[Hermes native and metadata]')))
  );
  interned.push(bytes(19, message(uint(1, 2), uint(7, 2))));
  const { frames, symbolicatedFrames, unmappedFrames } =
    await symbolicateFrames(profile, sourceMap);
  for (const [key, frame] of frames) {
    const id = frameIds.size + 1;
    frameIds.set(key, id);
    interned.push(bytes(5, message(uint(1, id), bytes(2, frame.name))));
    interned.push(
      bytes(
        6,
        message(
          uint(1, id),
          uint(2, id),
          uint(3, frame.kind === 'js' ? 1 : 2),
          uint(4, id)
        )
      )
    );
  }
  const stacks = new Map<string, number>();
  const samplePackets: Buffer[] = [];
  const sortedSamples = [...profile.samples].sort((a, b) =>
    Number(integer(a.ts, 'timestamp') - integer(b.ts, 'timestamp'))
  );
  for (const sample of sortedSamples) {
    if (Number(sample.pid) !== pid)
      throw new ProfilerError(
        'E_HERMES_PROFILE',
        'Hermes sample PID does not match session'
      );
    const tid = integer(sample.tid, 'tid');
    if (!tid || tid > 0x7fffffffn)
      throw new ProfilerError('E_HERMES_PROFILE', 'Invalid Hermes thread ID');
    const leaf = String(sample.sf);
    let stackId = stacks.get(leaf);
    if (!stackId) {
      const frameIdsInStack: number[] = [];
      const visited = new Set<string>();
      let key: string | undefined = leaf;
      while (key !== undefined) {
        if (visited.has(key))
          throw new ProfilerError(
            'E_HERMES_PROFILE',
            'Cycle in Hermes stack frame parents'
          );
        visited.add(key);
        const frame: Frame | undefined = profile.stackFrames[key];
        const id = frameIds.get(key);
        if (!frame || id === undefined)
          throw new ProfilerError(
            'E_HERMES_PROFILE',
            `Missing Hermes stack frame ${key}`
          );
        frameIdsInStack.push(id);
        key = frame.parent === undefined ? undefined : String(frame.parent);
      }
      stackId = stacks.size + 1;
      stacks.set(leaf, stackId);
      interned.push(
        bytes(
          7,
          message(
            uint(1, stackId),
            ...frameIdsInStack.reverse().map((id) => uint(2, id))
          )
        )
      );
    }
    samplePackets.push(
      packet(
        uint(10, sequence),
        uint(13, 2),
        uint(8, mapTime(sample.ts)),
        uint(58, 6),
        bytes(
          66,
          message(uint(2, pid), uint(3, tid), uint(4, stackId), uint(5, 0))
        )
      )
    );
  }
  const setup = packet(
    uint(10, sequence),
    uint(13, 1),
    bytes(12, concat(interned)),
    // Named separate sampling session. JS wall-clock samples are not hardware CPU counts.
    bytes(
      59,
      bytes(12, bytes(1, bytes(10, 'Hermes wall-clock samples (not CPU time)')))
    )
  );
  return {
    trace: concat([intactTrace, setup, ...samplePackets]),
    samples: samplePackets.length,
    nativeSamples,
    symbolicatedFrames,
    unmappedFrames,
    nativeFrequencyHz: samplingFrequencyHz,
    nativeRecordsLost: kernelRecordsLost,
    overlappingNativeSamples,
    skippedNativeSamples: decoded.skipped,
    nativeWarnings: nativeCoverage(native, manifest).warnings,
  };
}

/** Read an exported session; artifact paths resolve next to session.json. */
export function loadSession(session: string): {
  manifest: ProfileSessionManifest;
  hermesPath: string;
  nativePath: string | null;
} {
  let manifest: ProfileSessionManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(session, 'utf8'));
  } catch (error) {
    throw new ProfilerError(
      'E_SESSION_MANIFEST',
      `Cannot read session manifest ${session}: ${(error as Error).message}`
    );
  }
  // Exported sessions live together. Device absolute paths are resolved by basename locally.
  const resolve = (artifact: string | null) =>
    artifact
      ? path.resolve(path.dirname(session), path.basename(artifact))
      : null;
  const hermesPath = resolve(manifest.hermesProfilePath);
  if (!hermesPath)
    throw new ProfilerError(
      'E_SESSION_MANIFEST',
      'Session manifest has no Hermes profile'
    );
  return {
    manifest,
    hermesPath,
    nativePath: resolve(manifest.nativeProfilePath),
  };
}

export function nativeMissingError(manifest: ProfileSessionManifest) {
  return new ProfilerError(
    'E_NATIVE_MISSING',
    `Native capture did not produce a profile (nativeStatus: ${manifest.nativeStatus}` +
      (manifest.nativeError ? `, ${manifest.nativeError}` : '') +
      ')'
  );
}

export type MergeFormat = 'perfetto' | 'simpleperf' | 'folded';

export async function mergeSession(options: {
  session: string;
  sourceMap: string;
  output: string;
  format?: MergeFormat;
}) {
  const { manifest, hermesPath, nativePath } = loadSession(options.session);
  if (!nativePath) throw nativeMissingError(manifest);
  if (
    [nativePath, hermesPath, options.session, options.sourceMap].some(
      (p) => path.resolve(p) === path.resolve(options.output)
    )
  ) {
    throw new ProfilerError(
      'E_OUTPUT_CONFLICT',
      'Output must not overwrite an input artifact'
    );
  }
  const result = await mergeProfileBuffers(
    fs.readFileSync(nativePath),
    JSON.parse(fs.readFileSync(hermesPath, 'utf8')),
    manifest,
    fs.readFileSync(options.sourceMap, 'utf8')
  );
  let outputTrace = result.trace;
  let skippedSamples = result.skippedNativeSamples;
  let samples = result.samples;
  let nativeSamples = result.nativeSamples;
  const count = (exported: StackSample[]) => {
    samples = exported.filter((s) => s.hermes).length;
    nativeSamples = exported.filter(
      (s) => !s.hermes && Number(s.pid) === Number(manifest.pid)
    ).length;
  };
  if (options.format === 'folded') {
    const decoded = decodeStackSamples(result.trace);
    outputTrace = Buffer.from(toFolded(decoded.samples), 'utf8');
    skippedSamples = decoded.skipped;
    count(decoded.samples);
  } else if (options.format !== 'perfetto') {
    const simpleperf = toSimpleperf(result.trace, manifest.clockAnchors);
    outputTrace = simpleperf.trace;
    skippedSamples = simpleperf.skipped;
    count(simpleperf.samples);
  }
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
  fs.writeFileSync(
    options.output,
    new Uint8Array(
      outputTrace.buffer,
      outputTrace.byteOffset,
      outputTrace.byteLength
    )
  );
  return {
    output: options.output,
    format: options.format ?? 'simpleperf',
    sessionId: manifest.sessionId,
    // Samples in the output. Perfetto copies native packets as is; this counts the
    // decodable ones.
    samples,
    nativeSamples,
    symbolicatedFrames: result.symbolicatedFrames,
    unmappedFrames: result.unmappedFrames,
    requestedFrequencyHz: manifest.requestedOptions?.samplingFrequencyHz,
    nativeFrequencyHz: result.nativeFrequencyHz,
    nativeRecordsLost: result.nativeRecordsLost,
    overlappingNativeSamples: result.overlappingNativeSamples,
    skippedSamples,
    nativeWarnings: result.nativeWarnings,
  };
}
