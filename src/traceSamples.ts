import { inflateSync } from 'zlib';
import { ProfilerError } from './errors';
import { fields, tracePackets } from './perfettoProto';
import type { WireField } from './perfettoProto';

export interface StackFrame {
  name: string;
  /** Mapping path, e.g. `base.apk!libhermesvm.so` or `[Hermes JavaScript]`. */
  file: string;
  pc: bigint;
}

export interface StackSample {
  timestamp: bigint;
  /** Perfetto builtin clock: 3 = MONOTONIC, 6 = BOOTTIME. */
  clock: 3 | 6;
  pid: bigint;
  tid: bigint;
  /** Sample comes from the merged Hermes track rather than native sampling. */
  hermes: boolean;
  /** Leaf first. */
  frames: StackFrame[];
}

export interface DecodedStackSamples {
  samples: StackSample[];
  /** Samples that could not be decoded, by reason. They are skipped, not fatal. */
  skipped: Record<string, number>;
}

class SkipSample extends Error {}

const isFormatError = (error: unknown) =>
  error instanceof ProfilerError && error.code === 'E_TRACE_FORMAT';

/** Decode Perfetto PerfSample packets (native and merged Hermes) with interned stacks.
 * Native samples are untrusted: a malformed or unresolvable sample, packet or interned
 * entry is skipped and counted, losing only the samples that depend on it. A truncated
 * trace keeps its complete packets.
 */
export function decodeStackSamples(trace: Buffer): DecodedStackSamples {
  const num = (items: WireField[], id: number, fallback = 0n): bigint => {
    // Protobuf semantics: the last occurrence of a scalar field wins.
    let result = fallback;
    for (const item of items)
      if (item.id === id && typeof item.value === 'bigint') result = item.value;
    return result;
  };
  const str = (items: WireField[], id: number): string => {
    let result = '';
    for (const item of items)
      if (item.id === id && Buffer.isBuffer(item.value))
        result = item.value.toString('utf8');
    return result;
  };
  // Repeated uint64 fields may use either packed or unpacked encoding.
  const ids = (items: WireField[], id: number): bigint[] =>
    items
      .filter((item) => item.id === id)
      .flatMap(({ value }) => {
        if (typeof value === 'bigint') return [value];
        const result: bigint[] = [];
        let current = 0n;
        let shift = 0n;
        for (const b of value) {
          if (shift >= 64n) throw new SkipSample('invalid packed interned ID');
          current += BigInt(b % 128) * 2n ** shift;
          if (b < 128) {
            result.push(current);
            current = 0n;
            shift = 0n;
          } else shift += 7n;
        }
        if (shift) throw new SkipSample('truncated packed interned ID');
        return result;
      });
  type State = {
    /** Default clock; undefined after malformed TracePacketDefaults. */
    clock?: number;
    tables: Map<number, Map<bigint, WireField[]>>;
  };
  // Dropped packets (previous_packet_dropped) only lose the interned entries they held:
  // traced_perf interning IDs are monotonic and never reused with other content, even
  // across incremental-state clears, so samples whose entries arrived still resolve.
  const states = new Map<bigint, State>();
  const samples: StackSample[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const visit = (data: Buffer, depth = 0) => {
    if (depth > 4)
      throw new ProfilerError(
        'E_TRACE_FORMAT',
        'Excessively nested compressed trace'
      );
    const { packets, damage, otherFields } = tracePackets(data);
    if (!depth && !packets.length && data.length)
      throw new ProfilerError(
        'E_TRACE_FORMAT',
        `Expected Perfetto trace packets${damage ? ` (${damage})` : ''}`
      );
    // A cut-short packet is most likely a sample; count it like one.
    if (damage) skip('truncated or damaged packet');
    for (let i = 0; i < otherFields; i++) skip('malformed packet');
    for (const payload of packets) {
      try {
        visitPacket(payload, depth);
      } catch (error) {
        if (!isFormatError(error)) throw error;
        skip('malformed packet');
      }
    }
  };
  const visitPacket = (payload: Buffer, depth: number) => {
    const packet = [...fields(payload)];
    const sequence = num(packet, 10);
    const flags = num(packet, 13);
    // SEQ_INCREMENTAL_STATE_CLEARED = 1.
    if (!states.has(sequence) || flags % 2n === 1n)
      states.set(sequence, { clock: 6, tables: new Map() });
    const state = states.get(sequence)!;
    const lookup = (table: number, id: bigint): WireField[] => {
      const item = state.tables.get(table)?.get(id);
      if (!item) throw new SkipSample('missing interned data');
      return item;
    };
    for (const item of packet) {
      if (!Buffer.isBuffer(item.value)) continue;
      if (item.id === 50) {
        let inflated: Buffer;
        try {
          inflated = inflateSync(new Uint8Array(item.value), {
            maxOutputLength: 64 * 1024 * 1024,
          });
        } catch {
          skip('malformed compressed packets');
          continue;
        }
        visit(inflated, depth + 1);
      }
      if (item.id === 59) {
        try {
          state.clock = Number(
            num([...fields(item.value)], 58, BigInt(state.clock ?? 6))
          );
        } catch (error) {
          if (!isFormatError(error)) throw error;
          // Samples that rely on these defaults have no known clock.
          state.clock = undefined;
        }
      }
      if (item.id === 12) {
        // Keep the intact entries; samples referencing a lost one are skipped on lookup.
        try {
          for (const entry of fields(item.value)) {
            if (!Buffer.isBuffer(entry.value)) continue;
            let definition: WireField[];
            try {
              definition = [...fields(entry.value)];
            } catch (error) {
              if (!isFormatError(error)) throw error;
              continue;
            }
            if (!state.tables.has(entry.id))
              state.tables.set(entry.id, new Map());
            state.tables.get(entry.id)!.set(num(definition, 1), definition);
          }
        } catch (error) {
          if (!isFormatError(error)) throw error;
        }
      }
    }
    for (const item of packet) {
      if (item.id !== 66 || !Buffer.isBuffer(item.value)) continue;
      try {
        const sample = [...fields(item.value)];
        const stackId = num(sample, 4);
        if (!stackId) continue; // Lost/skipped samples don't have callchains.
        const pid = num(sample, 2);
        const tid = num(sample, 3);
        if (!pid || !tid) throw new SkipSample('no process/thread ID');
        const clock = Number(num(packet, 58, BigInt(state.clock ?? -1)));
        if (clock === -1)
          throw new SkipSample('unknown clock (malformed packet defaults)');
        if (clock !== 3 && clock !== 6)
          throw new SkipSample(`unsupported clock ${clock}`);
        const timestamp = num(packet, 8, -1n);
        if (timestamp < 0n) throw new SkipSample('no timestamp');
        let hermes = false;
        const frames = ids(lookup(7, stackId), 2)
          .reverse()
          .map((frameId): StackFrame => {
            const frame = lookup(6, frameId);
            const mapping = lookup(19, num(frame, 3));
            const file = ids(mapping, 7)
              .map((id) => str(lookup(17, id), 2))
              .join('/');
            hermes ||= file.startsWith('[Hermes ');
            const nameId = num(frame, 2);
            const pc = num(frame, 4);
            const name =
              (nameId ? str(lookup(5, nameId), 2) : '') ||
              `0x${pc.toString(16)}`;
            return { name, file, pc };
          });
        if (!frames.length) throw new SkipSample('empty callchain');
        samples.push({
          timestamp,
          clock: clock as 3 | 6,
          pid,
          tid,
          hermes,
          frames,
        });
      } catch (error) {
        if (error instanceof SkipSample) skip(error.message);
        // A corrupt sample payload only loses that sample.
        else if (isFormatError(error)) skip('malformed sample');
        else throw error;
      }
    }
  };
  visit(trace);
  // A thread belongs to one process. If samples disagree (a corrupt pid), the thread
  // keeps the process most of its samples (including merged Hermes samples) name.
  const owners = new Map<bigint, Map<bigint, number>>();
  for (const { tid, pid } of samples) {
    const counts = owners.get(tid) ?? new Map<bigint, number>();
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
    owners.set(tid, counts);
  }
  const owner = new Map<bigint, bigint>();
  for (const [tid, counts] of owners) {
    let best = 0;
    for (const [pid, count] of counts)
      if (count > best) {
        best = count;
        owner.set(tid, pid);
      }
  }
  return {
    samples: samples.filter((sample) => {
      if (owner.get(sample.tid) === sample.pid) return true;
      skip('thread ID reused across processes');
      return false;
    }),
    skipped,
  };
}
