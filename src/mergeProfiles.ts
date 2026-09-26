import fs from 'fs';
import { toSimpleperf } from './simpleperf';
import path from 'path';
import { SourceMapConsumer } from 'source-map';
import {
  bytes,
  concat,
  message,
  inspectNativeTrace,
  packet,
  uint,
} from './perfettoProto';

export interface ClockAnchor {
  monotonicNs: string;
  boottimeNs: string;
  uncertaintyNs?: string;
}
export interface ProfileSessionManifest {
  version: 1;
  sessionId: string;
  pid: number;
  hermesClock: 'monotonic';
  hermesProfilePath: string;
  nativeProfilePath: string | null;
  nativeStatus: string;
  clockAnchors: ClockAnchor[];
  boundaries?: { nativeRequest?: ClockAnchor; nativeResult?: ClockAnchor };
}
interface Frame {
  name: string;
  category?: string;
  parent?: string | number;
  line?: string | number;
  column?: string | number;
  funcVirtAddr?: string | number;
  offset?: string | number;
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
    throw new Error(
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
    throw new Error('At least start and stop clock anchors are required');
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
      throw new Error('Clock calibration uncertainty exceeds 1 ms');
    if (
      abs(clock.boot - clock.mono - offset) >
      first.uncertainty + clock.uncertainty + 100000n
    ) {
      throw new Error(
        'Device suspended or clocks changed during capture; cannot synchronize accurately'
      );
    }
  }
  return (us) => {
    const ns = integer(us, 'Hermes timestamp') * 1000n;
    // Clock anchors bracket enable/disable; allow quantization and scheduling tolerance.
    if (ns < first.mono - 1000000n || ns > last.mono + 1000000n) {
      throw new Error(
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
}> {
  if (
    manifest.version !== 1 ||
    manifest.hermesClock !== 'monotonic' ||
    !manifest.sessionId
  ) {
    throw new Error('Unsupported session manifest version or Hermes clock');
  }
  const pid = Number(integer(manifest.pid, 'pid'));
  if (pid <= 0 || pid > 0x7fffffff) throw new Error('Invalid session pid');
  if (
    !profile.stackFrames ||
    !Array.isArray(profile.samples) ||
    !profile.samples.length
  ) {
    throw new Error('Hermes profile has no samples or stack frames');
  }
  const { sequence, samplePids, stackSampleCounts, sampleTimes } =
    inspectNativeTrace(nativeTrace);
  if (samplePids.size && !samplePids.has(pid)) {
    throw new Error(
      'Native sample PIDs do not match the session; wrong native trace'
    );
  }
  const nativeSamples = stackSampleCounts.get(pid) ?? 0;
  if (!nativeSamples) {
    throw new Error(
      'Native trace contains no stack samples for this app. ProfilingManager may return success after sampling failed or Android removed sample payloads during redaction; this capture cannot be merged.'
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
  const nativeTimes = sampleTimes
    .filter((sample) => sample.pid === pid)
    .map((sample) => {
      if (sample.clockId === 6) return sample.timestamp;
      if (sample.clockId === 3)
        return sample.timestamp + first.boot - first.mono;
      throw new Error(
        `Unsupported native sample clock ${sample.clockId}; cannot verify session time coverage`
      );
    });
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
    throw new Error(
      'Native samples do not overlap session clock anchors; wrong native trace for this session'
    );
  }
  const interned: Buffer[] = [];
  const frameIds = new Map<string, number>();
  let symbolicatedFrames = 0;
  let unmappedFrames = 0;
  // A dedicated mapping identifies JS frames without inventing native addresses.
  interned.push(
    bytes(17, message(uint(1, 1), bytes(2, '[Hermes JavaScript]')))
  );
  interned.push(bytes(19, message(uint(1, 1), uint(7, 1))));
  interned.push(
    bytes(17, message(uint(1, 2), bytes(2, '[Hermes native and metadata]')))
  );
  interned.push(bytes(19, message(uint(1, 2), uint(7, 2))));
  const consumer = await new SourceMapConsumer(JSON.parse(sourceMap));
  try {
    for (const [key, frame] of Object.entries(profile.stackFrames)) {
      const id = frameIds.size + 1;
      frameIds.set(key, id);
      let name = frame.name || '(anonymous)';
      const isJavaScript =
        frame.category === 'JavaScript' || frame.category === undefined;
      let line = Number(frame.line);
      let column = Number(frame.column) - 1;
      if (frame.funcVirtAddr !== undefined && frame.offset !== undefined) {
        line = 1;
        column = Number(frame.funcVirtAddr) + Number(frame.offset);
      }
      if (
        isJavaScript &&
        Number.isSafeInteger(line) &&
        line >= 1 &&
        Number.isSafeInteger(column) &&
        column >= 0
      ) {
        const original = consumer.originalPositionFor({ line, column });
        if (original.source !== null && original.line !== null) {
          name = `${original.name || name} (${original.source}:${
            original.line
          }:${(original.column ?? 0) + 1})`;
          symbolicatedFrames++;
        } else {
          unmappedFrames++;
          name += ' [unmapped JS]';
        }
      } else if (frame.category === 'JavaScript') {
        unmappedFrames++;
        name += ' [unmapped JS]';
      }
      interned.push(bytes(5, message(uint(1, id), bytes(2, name))));
      interned.push(
        bytes(
          6,
          message(
            uint(1, id),
            uint(2, id),
            uint(3, isJavaScript ? 1 : 2),
            uint(4, id)
          )
        )
      );
    }
  } finally {
    consumer.destroy();
  }
  if (!symbolicatedFrames)
    throw new Error(
      'Source map did not resolve any JS frames; use the exact release composed Hermes source map'
    );
  const stacks = new Map<string, number>();
  const samplePackets: Buffer[] = [];
  const sortedSamples = [...profile.samples].sort((a, b) =>
    Number(integer(a.ts, 'timestamp') - integer(b.ts, 'timestamp'))
  );
  for (const sample of sortedSamples) {
    if (Number(sample.pid) !== pid)
      throw new Error('Hermes sample PID does not match session');
    const tid = integer(sample.tid, 'tid');
    if (!tid || tid > 0x7fffffffn) throw new Error('Invalid Hermes thread ID');
    const leaf = String(sample.sf);
    let stackId = stacks.get(leaf);
    if (!stackId) {
      const frames: number[] = [];
      const visited = new Set<string>();
      let key: string | undefined = leaf;
      while (key !== undefined) {
        if (visited.has(key))
          throw new Error('Cycle in Hermes stack frame parents');
        visited.add(key);
        const frame: Frame | undefined = profile.stackFrames[key];
        const id = frameIds.get(key);
        if (!frame || id === undefined)
          throw new Error(`Missing Hermes stack frame ${key}`);
        frames.push(id);
        key = frame.parent === undefined ? undefined : String(frame.parent);
      }
      stackId = stacks.size + 1;
      stacks.set(leaf, stackId);
      interned.push(
        bytes(
          7,
          message(
            uint(1, stackId),
            ...frames.reverse().map((id) => uint(2, id))
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
    trace: concat([nativeTrace, setup, ...samplePackets]),
    samples: samplePackets.length,
    nativeSamples,
    symbolicatedFrames,
    unmappedFrames,
  };
}

export async function mergeSession(options: {
  session: string;
  sourceMap: string;
  output: string;
  format?: 'perfetto' | 'simpleperf';
}) {
  const manifest = JSON.parse(
    fs.readFileSync(options.session, 'utf8')
  ) as ProfileSessionManifest;
  const resolveArtifact = (artifact: string | null) => {
    if (!artifact)
      throw new Error(
        'Native capture did not produce a profile; inspect nativeStatus/nativeError in the manifest'
      );
    // Exported sessions live together. Device absolute paths are resolved by basename locally.
    return path.resolve(path.dirname(options.session), path.basename(artifact));
  };
  const nativePath = resolveArtifact(manifest.nativeProfilePath);
  const hermesPath = resolveArtifact(manifest.hermesProfilePath);
  if (
    [nativePath, hermesPath, options.session, options.sourceMap].some(
      (p) => path.resolve(p) === path.resolve(options.output)
    )
  ) {
    throw new Error('Output must not overwrite an input artifact');
  }
  const result = await mergeProfileBuffers(
    fs.readFileSync(nativePath),
    JSON.parse(fs.readFileSync(hermesPath, 'utf8')),
    manifest,
    fs.readFileSync(options.sourceMap, 'utf8')
  );
  const outputTrace =
    options.format !== 'perfetto'
      ? toSimpleperf(result.trace, manifest.clockAnchors)
      : result.trace;
  fs.writeFileSync(
    options.output,
    new Uint8Array(
      outputTrace.buffer,
      outputTrace.byteOffset,
      outputTrace.byteLength
    )
  );
  return {
    samples: result.samples,
    nativeSamples: result.nativeSamples,
    symbolicatedFrames: result.symbolicatedFrames,
    unmappedFrames: result.unmappedFrames,
  };
}
