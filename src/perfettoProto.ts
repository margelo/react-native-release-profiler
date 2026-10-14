/* eslint-disable no-bitwise -- Protobuf varints encode integer bits. */
import { inflateSync } from 'zlib';
import { ProfilerError } from './errors';

/** Minimal wire-format helpers for the stable Perfetto fields used by the merger.
 * Field definitions: google/perfetto protos/perfetto/trace/{trace_packet,
 * profiling/profile_packet,profiling/profile_common,interned_data/interned_data}.proto.
 * Unknown native fields are never reserialized, so native traces remain intact.
 */
export function varint(value: bigint | number): Buffer {
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new ProfilerError(
      'E_TRACE_FORMAT',
      'Protobuf integer is outside uint64 range'
    );
  }
  const encoded = [];
  do {
    encoded.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(encoded);
}

export function uint(field: number, value: bigint | number): Buffer {
  return message(varint(field * 8), varint(value));
}

export function bytes(field: number, value: Buffer | string): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value) : value;
  return message(varint(field * 8 + 2), varint(payload.length), payload);
}

export function concat(parts: Buffer[]): Buffer {
  return Buffer.concat(
    parts.map(
      (field) =>
        new Uint8Array(field.buffer, field.byteOffset, field.byteLength)
    )
  );
}

export function message(...parts: Buffer[]): Buffer {
  return concat(parts);
}

export function packet(...parts: Buffer[]): Buffer {
  return bytes(1, message(...parts));
}

export interface WireField {
  id: number;
  value: bigint | Buffer;
}

/** Decode one message's fields. `cursor.offset` is updated to the end of each field
 * before it is yielded, so callers can tell how much of `data` was intact.
 */
export function* fields(
  data: Buffer,
  cursor?: { offset: number }
): Generator<WireField> {
  let offset = 0;
  const read = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = data[offset++];
      if (b === undefined || (shift === 63n && b > 1)) {
        throw new ProfilerError(
          'E_TRACE_FORMAT',
          'Malformed or truncated protobuf varint'
        );
      }
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) return value;
    }
    throw new ProfilerError('E_TRACE_FORMAT', 'Invalid protobuf varint');
  };
  while (offset < data.length) {
    const tag = read();
    const id = Number(tag >> 3n);
    if (!id || id > 0x1fffffff)
      throw new ProfilerError('E_TRACE_FORMAT', 'Invalid protobuf field');
    const wire = Number(tag & 7n);
    let value: bigint | Buffer;
    if (wire === 0) {
      value = read();
    } else {
      const length =
        wire === 2 ? Number(read()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (
        length < 0 ||
        !Number.isSafeInteger(length) ||
        offset + length > data.length
      ) {
        throw new ProfilerError(
          'E_TRACE_FORMAT',
          'Malformed or truncated protobuf payload'
        );
      }
      value = data.subarray(offset, offset + length);
      offset += length;
    }
    if (cursor) cursor.offset = offset;
    yield { id, value };
  }
}

const isFormatError = (error: unknown) =>
  error instanceof ProfilerError && error.code === 'E_TRACE_FORMAT';

/** The packets of a Perfetto Trace. A trace that is cut short (or damaged) keeps every
 * complete packet before the damage: `intactBytes` is then the length of that prefix
 * and `damage` says what was wrong. Fields other than packets are counted, not kept.
 */
export function tracePackets(trace: Buffer): {
  packets: Buffer[];
  intactBytes: number;
  damage?: string;
  otherFields: number;
} {
  const packets: Buffer[] = [];
  const cursor = { offset: 0 };
  let otherFields = 0;
  let damage: string | undefined;
  try {
    for (const field of fields(trace, cursor)) {
      if (field.id === 1 && Buffer.isBuffer(field.value))
        packets.push(field.value);
      else otherFields++;
    }
  } catch (error) {
    if (!isFormatError(error)) throw error;
    damage = (error as Error).message;
  }
  return { packets, intactBytes: cursor.offset, damage, otherFields };
}

export interface NativeTraceInfo {
  /** A sequence ID that no native producer uses. */
  sequence: number;
  samplePids: Set<number>;
  stackSampleCounts: Map<number, number>;
  sampleTimes: { pid: number; timestamp: bigint; clockId: number }[];
  /** Effective perf sampling frequency from the trace config (Android may clamp requests). */
  samplingFrequencyHz?: number;
  /** TraceConfig.duration_ms: the tracing service stops the capture after it. */
  durationMs?: number;
  /** PerfSample.kernel_records_lost: samples dropped by the kernel ring buffer. */
  kernelRecordsLost: number;
  /** Length of the intact prefix: less than `totalBytes` if the trace is truncated or damaged. */
  intactBytes: number;
  totalBytes: number;
  /** Packets (or parts of them) that could not be parsed and were ignored. */
  malformedPackets: number;
  /** previous_packet_dropped after a sequence's first packet: packets lost mid-capture. */
  droppedPacketEvents: number;
  /** BOOTTIME of the tracing service's "all data sources started" and "tracing disabled". */
  startedNs?: bigint;
  stoppedNs?: bigint;
  /** TraceStats.buffer_stats (last stats packet, summed over buffers). */
  buffer?: {
    sizeBytes: number;
    chunksDiscarded: number;
    chunksOverwritten: number;
    patchesFailed: number;
    packetsLost: number;
  };
}

/** Summarize a native trace without decoding stacks. Damaged packets and samples are
 * skipped and counted (see `malformedPackets`, `intactBytes`), never fatal.
 */
export function inspectNativeTrace(trace: Buffer): NativeTraceInfo {
  let max = 0;
  let samplingFrequencyHz: number | undefined;
  let durationMs: number | undefined;
  let kernelRecordsLost = 0;
  let malformedPackets = 0;
  let droppedPacketEvents = 0;
  let buffer: NativeTraceInfo['buffer'];
  const serviceEvents = new Map<number, bigint[]>();
  const nested = (data: Buffer, id: number) =>
    [...fields(data)]
      .filter((item) => item.id === id && Buffer.isBuffer(item.value))
      .map((item) => item.value as Buffer);
  const scalar = (data: Buffer, id: number) => {
    let result: bigint | undefined;
    for (const item of fields(data))
      if (item.id === id && typeof item.value === 'bigint') result = item.value;
    return result;
  };
  const readConfig = (config: Buffer) => {
    const duration = scalar(config, 3);
    if (duration) durationMs = Number(duration);
    // TraceConfig.data_sources[].config.perf_event_config.timebase.frequency
    for (const source of nested(config, 2)) {
      for (const sourceConfig of nested(source, 1)) {
        for (const perf of nested(sourceConfig, 111)) {
          for (const timebase of nested(perf, 15)) {
            const frequency = scalar(timebase, 2);
            if (frequency !== undefined)
              samplingFrequencyHz = Number(frequency);
          }
        }
      }
    }
  };
  // TraceStats.BufferStats: buffer_size 12, chunks_overwritten 3, patches_failed 6,
  // chunks_discarded 18, trace_writer_packet_loss 19.
  const readStats = (stats: Buffer) => {
    const total = {
      sizeBytes: 0,
      chunksDiscarded: 0,
      chunksOverwritten: 0,
      patchesFailed: 0,
      packetsLost: 0,
    };
    for (const bufferStats of nested(stats, 1)) {
      const value = (id: number) => Number(scalar(bufferStats, id) ?? 0n);
      total.sizeBytes += value(12);
      total.chunksOverwritten += value(3);
      total.patchesFailed += value(6);
      total.chunksDiscarded += value(18);
      total.packetsLost += value(19);
    }
    buffer = total;
  };
  let count = 0;
  const samplePids = new Set<number>();
  const sampleTimes: { pid: number; timestamp: bigint; clockId: number }[] = [];
  /** -1: the sequence's TracePacketDefaults were malformed (clock unknown). */
  const defaultClocks = new Map<number, number>();
  const sequences = new Set<number>();
  const stackSampleCounts = new Map<number, number>();
  const { packets, intactBytes, damage, otherFields } = tracePackets(trace);
  malformedPackets += otherFields;
  const inspect = (payload: Buffer, depth: number) => {
    if (depth > 4)
      throw new ProfilerError(
        'E_TRACE_FORMAT',
        'Excessively nested compressed Perfetto packets'
      );
    const packetFields = [...fields(payload)];
    count++;
    const numberField = (id: number) => {
      const value = packetFields.find((item) => item.id === id)?.value;
      return typeof value === 'bigint' ? value : undefined;
    };
    const sequence = Number(numberField(10) ?? 0n);
    const flags = numberField(13) ?? 0n;
    if (flags & 1n) defaultClocks.delete(sequence);
    // Set on a sequence's first packet; later it means the writer lost packets.
    if (numberField(42) && sequences.has(sequence) && !numberField(87))
      droppedPacketEvents++;
    sequences.add(sequence);
    const defaults = packetFields.find((item) => item.id === 59)?.value;
    if (Buffer.isBuffer(defaults)) {
      try {
        const clock = scalar(defaults, 58);
        if (clock !== undefined) defaultClocks.set(sequence, Number(clock));
      } catch (error) {
        if (!isFormatError(error)) throw error;
        malformedPackets++;
        defaultClocks.set(sequence, -1);
      }
    }
    const timestamp = numberField(8);
    const clockId = Number(numberField(58) ?? defaultClocks.get(sequence) ?? 6);
    for (const item of packetFields) {
      if (!Buffer.isBuffer(item.value)) {
        if (item.id === 10) max = Math.max(max, Number(item.value));
        continue;
      }
      try {
        if (item.id === 50) {
          const compressed = new Uint8Array(
            item.value.buffer,
            item.value.byteOffset,
            item.value.byteLength
          );
          let inflated: Buffer;
          try {
            inflated = inflateSync(compressed, {
              maxOutputLength: 64 * 1024 * 1024,
            });
          } catch (error) {
            throw new ProfilerError(
              'E_TRACE_FORMAT',
              `Invalid compressed Perfetto packets: ${String(error)}`
            );
          }
          const inner = tracePackets(inflated);
          if (inner.damage || inner.otherFields) malformedPackets++;
          for (const innerPacket of inner.packets) {
            try {
              inspect(innerPacket, depth + 1);
            } catch (error) {
              if (!isFormatError(error)) throw error;
              malformedPackets++;
            }
          }
        }
        if (item.id === 33) readConfig(item.value);
        if (item.id === 35) readStats(item.value);
        if (item.id === 69 && timestamp !== undefined && clockId === 6) {
          // TracingServiceEvent: 1 all_data_sources_started, 5 tracing_disabled.
          for (const event of fields(item.value)) {
            if (event.id !== 1 && event.id !== 5) continue;
            serviceEvents.set(event.id, [
              ...(serviceEvents.get(event.id) ?? []),
              timestamp,
            ]);
          }
        }
        if (item.id === 66) {
          let pid = 0;
          let hasStack = false;
          let lost = 0;
          for (const sample of fields(item.value)) {
            if (sample.id === 17 && typeof sample.value === 'bigint')
              lost += Number(sample.value);
            if (sample.id === 2 && typeof sample.value === 'bigint')
              pid = Number(sample.value);
            if (
              sample.id === 4 &&
              typeof sample.value === 'bigint' &&
              sample.value > 0n
            )
              hasStack = true;
          }
          kernelRecordsLost += lost;
          if (pid > 0) {
            samplePids.add(pid);
            // Samples without a timestamp are unusable; skip them like the exporters do.
            if (hasStack && timestamp !== undefined) {
              stackSampleCounts.set(pid, (stackSampleCounts.get(pid) ?? 0) + 1);
              sampleTimes.push({ pid, timestamp, clockId });
            }
          }
        }
      } catch (error) {
        // One damaged field loses only what it holds, not the capture.
        if (!isFormatError(error)) throw error;
        malformedPackets++;
      }
    }
  };
  for (const payload of packets) {
    try {
      inspect(payload, 0);
    } catch (error) {
      if (!isFormatError(error)) throw error;
      malformedPackets++;
    }
  }
  if (!count || max >= 0xffffffff)
    throw new ProfilerError(
      'E_TRACE_FORMAT',
      `Invalid native Perfetto trace${damage ? `: ${damage}` : ''}`
    );
  const earliest = (values?: bigint[]) =>
    values?.reduce((a, b) => (b < a ? b : a));
  return {
    sequence: max + 1,
    samplePids,
    stackSampleCounts,
    sampleTimes,
    samplingFrequencyHz,
    durationMs,
    kernelRecordsLost,
    intactBytes,
    totalBytes: trace.length,
    malformedPackets,
    droppedPacketEvents,
    startedNs: earliest(serviceEvents.get(1)),
    stoppedNs: earliest(serviceEvents.get(5)),
    buffer,
  };
}

/** Native data the user would otherwise never notice is missing: no samples for part of
 * the JS recording (sampling started late or stopped early, buffer overflow) or packets
 * lost/damaged in the trace. Shared by merge and analyze.
 */
export function nativeCoverage(
  native: NativeTraceInfo,
  session: {
    pid: number;
    clockAnchors: { monotonicNs: string; boottimeNs: string }[];
    boundaries?: {
      hermesStart?: { boottimeNs: string };
      nativeResult?: { boottimeNs: string };
    };
    requestedOptions?: { durationMs?: number };
  },
  /** The JS (Hermes) recording, BOOTTIME ns. Default: session start to stop anchors. */
  js?: { startNs: bigint; endNs: bigint }
): { warnings: string[] } {
  const warnings: string[] = [];
  const nanos = (value: unknown) => {
    try {
      return typeof value === 'string' || typeof value === 'number'
        ? BigInt(value)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const seconds = (ns: bigint) => {
    const value = Number(ns) / 1e9;
    return `${value.toFixed(Math.abs(value) < 10 ? 2 : 1)} s`;
  };
  if (native.intactBytes < native.totalBytes)
    warnings.push(
      `Native trace is truncated or damaged after byte ${native.intactBytes} of ${native.totalBytes}; only the packets before it were used`
    );
  const anchors = (session.clockAnchors ?? [])
    .map((a) => ({ mono: nanos(a.monotonicNs), boot: nanos(a.boottimeNs) }))
    .filter(
      (a): a is { mono: bigint; boot: bigint } =>
        a.mono !== undefined && a.boot !== undefined
    )
    .sort((a, b) => (a.mono < b.mono ? -1 : a.mono > b.mono ? 1 : 0));
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const b = native.buffer;
  const losses = [
    b?.chunksDiscarded && `${b.chunksDiscarded} buffer chunks discarded`,
    b?.chunksOverwritten && `${b.chunksOverwritten} buffer chunks overwritten`,
    b?.patchesFailed && `${b.patchesFailed} packet patches failed`,
    b?.packetsLost && `${b.packetsLost} packets lost by trace writers`,
    native.droppedPacketEvents &&
      `packets dropped mid-capture ${native.droppedPacketEvents}×`,
  ].filter(Boolean);
  if (!first || !last) {
    if (losses.length)
      warnings.push(
        `Native trace lost data (${losses.join(
          ', '
        )}); native samples are missing`
      );
    return { warnings };
  }
  const jsStart =
    js?.startNs ??
    nanos(session.boundaries?.hermesStart?.boottimeNs) ??
    first.boot;
  const jsEnd = js?.endNs ?? last.boot;
  const recording = `${seconds(jsEnd - jsStart)} JS recording`;
  const pid = Number(session.pid);
  const times = native.sampleTimes
    .filter((t) => t.pid === pid && (t.clockId === 3 || t.clockId === 6))
    .map((t) =>
      t.clockId === 3 ? t.timestamp + first.boot - first.mono : t.timestamp
    )
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  if (b && (b.chunksDiscarded || b.chunksOverwritten)) {
    const firstSample = times[0];
    const lastSample = times[times.length - 1];
    warnings.push(
      `Native trace buffer (${Math.round(
        b.sizeBytes / 1024
      )} KB) overflowed (${losses.join(', ')}): ${
        firstSample !== undefined && lastSample !== undefined
          ? `native samples cover only ${seconds(
              firstSample - jsStart
            )} to ${seconds(lastSample - jsStart)} of the ${recording}`
          : 'native samples are missing'
      }. Record with a larger bufferSizeKb`
    );
  } else if (losses.length)
    warnings.push(
      `Native trace lost data (${losses.join(
        ', '
      )}); some native samples are missing`
    );
  const gap = 250_000_000n;
  const started = native.startedNs;
  if (started !== undefined && started - jsStart > gap && started < jsEnd)
    warnings.push(
      `Native sampling started ${seconds(
        started - jsStart
      )} after JS sampling: the first ${seconds(
        started - jsStart
      )} of the ${recording} has no native samples (e.g. Android was still stopping a previous or cancelled capture)`
    );
  const stopped =
    native.stoppedNs ?? nanos(session.boundaries?.nativeResult?.boottimeNs);
  if (stopped !== undefined && jsEnd - stopped > gap && stopped > jsStart) {
    const duration = native.durationMs ?? session.requestedOptions?.durationMs;
    const ran =
      started !== undefined ? Number(stopped - started) / 1e6 : undefined;
    warnings.push(
      `Native sampling stopped ${seconds(
        jsEnd - stopped
      )} before JS sampling ended: the last ${seconds(
        jsEnd - stopped
      )} of the ${recording} has no native samples${
        duration && ran !== undefined && ran >= duration - 1000
          ? `. It ran for its full durationMs (${duration} ms); record with a larger durationMs`
          : ''
      }`
    );
  }
  return { warnings };
}
