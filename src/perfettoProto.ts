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

export function* fields(data: Buffer): Generator<WireField> {
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
    if (wire === 0) {
      yield { id, value: read() };
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
      yield { id, value: data.subarray(offset, offset + length) };
      offset += length;
    }
  }
}

/** Reserve a sequence without colliding with any native producer. */
export function inspectNativeTrace(trace: Buffer): {
  sequence: number;
  samplePids: Set<number>;
  stackSampleCounts: Map<number, number>;
  sampleTimes: { pid: number; timestamp: bigint; clockId: number }[];
  /** Effective perf sampling frequency from the trace config (Android may clamp requests). */
  samplingFrequencyHz?: number;
  /** PerfSample.kernel_records_lost: samples dropped by the kernel ring buffer. */
  kernelRecordsLost: number;
} {
  let max = 0;
  let samplingFrequencyHz: number | undefined;
  let kernelRecordsLost = 0;
  // TraceConfig.data_sources[].config.perf_event_config.timebase.frequency
  const readFrequency = (config: Buffer) => {
    const nested = (data: Buffer, id: number) =>
      [...fields(data)]
        .filter((item) => item.id === id && Buffer.isBuffer(item.value))
        .map((item) => item.value as Buffer);
    for (const source of nested(config, 2)) {
      for (const sourceConfig of nested(source, 1)) {
        for (const perf of nested(sourceConfig, 111)) {
          for (const timebase of nested(perf, 15)) {
            const frequency = [...fields(timebase)].find(
              (item) => item.id === 2
            )?.value;
            if (typeof frequency === 'bigint')
              samplingFrequencyHz = Number(frequency);
          }
        }
      }
    }
  };
  let count = 0;
  const samplePids = new Set<number>();
  const sampleTimes: { pid: number; timestamp: bigint; clockId: number }[] = [];
  const defaultClocks = new Map<number, number>();
  const stackSampleCounts = new Map<number, number>();
  const inspect = (data: Buffer, depth: number) => {
    if (depth > 4)
      throw new ProfilerError(
        'E_TRACE_FORMAT',
        'Excessively nested compressed Perfetto packets'
      );
    for (const field of fields(data)) {
      if (field.id !== 1 || !Buffer.isBuffer(field.value)) {
        throw new ProfilerError(
          'E_TRACE_FORMAT',
          'Expected an uncompressed Perfetto Trace protobuf'
        );
      }
      count++;
      const packetFields = [...fields(field.value)];
      const numberField = (id: number) => {
        const value = packetFields.find((item) => item.id === id)?.value;
        return typeof value === 'bigint' ? value : undefined;
      };
      const sequence = Number(numberField(10) ?? 0n);
      if ((numberField(13) ?? 0n) & 1n) defaultClocks.delete(sequence);
      const defaults = packetFields.find((item) => item.id === 59)?.value;
      if (Buffer.isBuffer(defaults)) {
        const clock = [...fields(defaults)].find(
          (item) => item.id === 58
        )?.value;
        if (typeof clock === 'bigint')
          defaultClocks.set(sequence, Number(clock));
      }
      const timestamp = numberField(8);
      const clockId = Number(
        numberField(58) ?? defaultClocks.get(sequence) ?? 6
      );
      for (const nested of packetFields) {
        if (nested.id === 50 && Buffer.isBuffer(nested.value)) {
          try {
            const compressed = new Uint8Array(
              nested.value.buffer,
              nested.value.byteOffset,
              nested.value.byteLength
            );
            inspect(
              inflateSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }),
              depth + 1
            );
          } catch (error) {
            throw new ProfilerError(
              'E_TRACE_FORMAT',
              `Invalid compressed Perfetto packets: ${String(error)}`
            );
          }
        }
        if (nested.id === 33 && Buffer.isBuffer(nested.value)) {
          readFrequency(nested.value);
        }
        if (nested.id === 66 && Buffer.isBuffer(nested.value)) {
          let pid = 0;
          let hasStack = false;
          for (const sample of fields(nested.value)) {
            if (sample.id === 17 && typeof sample.value === 'bigint')
              kernelRecordsLost += Number(sample.value);
            if (sample.id === 2 && typeof sample.value === 'bigint')
              pid = Number(sample.value);
            if (
              sample.id === 4 &&
              typeof sample.value === 'bigint' &&
              sample.value > 0n
            )
              hasStack = true;
          }
          if (pid > 0) {
            samplePids.add(pid);
            // Samples without a timestamp are unusable; skip them like the exporters do.
            if (hasStack && timestamp !== undefined) {
              stackSampleCounts.set(pid, (stackSampleCounts.get(pid) ?? 0) + 1);
              sampleTimes.push({ pid, timestamp, clockId });
            }
          }
        }
        if (nested.id === 10 && typeof nested.value === 'bigint') {
          max = Math.max(max, Number(nested.value));
        }
      }
    }
  };
  inspect(trace, 0);
  if (!count || max >= 0xffffffff)
    throw new ProfilerError('E_TRACE_FORMAT', 'Invalid native Perfetto trace');
  return {
    sequence: max + 1,
    samplePids,
    stackSampleCounts,
    sampleTimes,
    samplingFrequencyHz,
    kernelRecordsLost,
  };
}
