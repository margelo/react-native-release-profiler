import { inflateSync } from 'zlib';
import { bytes, concat, fields, message, uint } from './perfettoProto';
import type { WireField } from './perfettoProto';
import type { ClockAnchor } from './mergeProfiles';

// Simpleperf report-sample --protobuf container and schema:
// https://android.googlesource.com/platform/system/extras/+/main/simpleperf/cmd_report_sample.proto
// This is a sampled-stack report, not raw perf.data or measured CPU durations.
export function toSimpleperf(trace: Buffer, anchors: ClockAnchor[]): Buffer {
  const first = anchors[0];
  if (!first)
    throw new Error('Clock anchors are required for Simpleperf export');
  const bootOffset = BigInt(first.boottimeNs) - BigInt(first.monotonicNs);
  const num = (items: WireField[], id: number, fallback = 0n): bigint => {
    const value = items.find((item) => item.id === id)?.value;
    return typeof value === 'bigint' ? value : fallback;
  };
  const str = (items: WireField[], id: number): string => {
    const value = items.find((item) => item.id === id)?.value;
    return Buffer.isBuffer(value) ? value.toString('utf8') : '';
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
          if (shift >= 64n) throw new Error('Invalid packed interned ID');
          current += BigInt(b % 128) * 2n ** shift;
          if (b < 128) {
            result.push(current);
            current = 0n;
            shift = 0n;
          } else shift += 7n;
        }
        if (shift) throw new Error('Truncated packed interned ID');
        return result;
      });
  type State = { clock: number; tables: Map<number, Map<bigint, WireField[]>> };
  const states = new Map<bigint, State>();
  const files = new Map<string, { id: number; symbols: Map<string, number> }>();
  const threads = new Map<bigint, bigint>();
  const hermesThreads = new Set<bigint>();
  const samples: {
    time: bigint;
    tid: bigint;
    hermes: boolean;
    chain: Buffer[];
  }[] = [];
  const visit = (data: Buffer, depth = 0) => {
    if (depth > 4) throw new Error('Excessively nested compressed trace');
    for (const top of fields(data)) {
      if (top.id !== 1 || !Buffer.isBuffer(top.value))
        throw new Error('Expected Perfetto trace packets');
      const packet = [...fields(top.value)];
      const sequence = num(packet, 10);
      if (!states.has(sequence) || num(packet, 13) % 2n === 1n)
        states.set(sequence, { clock: 6, tables: new Map() });
      const state = states.get(sequence)!;
      const lookup = (table: number, id: bigint): WireField[] => {
        const item = state.tables.get(table)?.get(id);
        if (!item) throw new Error(`Missing interned field ${table}:${id}`);
        return item;
      };
      for (const item of packet) {
        if (!Buffer.isBuffer(item.value)) continue;
        if (item.id === 50) {
          visit(
            inflateSync(new Uint8Array(item.value), {
              maxOutputLength: 64 * 1024 * 1024,
            }),
            depth + 1
          );
        }
        if (item.id === 59) {
          state.clock = Number(
            num([...fields(item.value)], 58, BigInt(state.clock))
          );
        }
        if (item.id === 12) {
          for (const entry of fields(item.value)) {
            if (!Buffer.isBuffer(entry.value)) continue;
            const definition = [...fields(entry.value)];
            if (!state.tables.has(entry.id))
              state.tables.set(entry.id, new Map());
            state.tables.get(entry.id)!.set(num(definition, 1), definition);
          }
        }
      }
      for (const item of packet) {
        if (item.id !== 66 || !Buffer.isBuffer(item.value)) continue;
        const sample = [...fields(item.value)];
        const stackId = num(sample, 4);
        if (!stackId) continue; // Lost/skipped samples don't have callchains.
        const pid = num(sample, 2);
        const tid = num(sample, 3);
        if (!pid || !tid) throw new Error('Sample has no process/thread ID');
        if (threads.has(tid) && threads.get(tid) !== pid)
          throw new Error('Thread ID reused across processes');
        threads.set(tid, pid);
        const clock = Number(num(packet, 58, BigInt(state.clock)));
        if (clock !== 3 && clock !== 6)
          throw new Error(`Unsupported sample clock ${clock}`);
        const timestamp = num(packet, 8, -1n);
        if (timestamp < 0n) throw new Error('Sample has no timestamp');
        const time = timestamp - (clock === 6 ? bootOffset : 0n);
        let hermes = false;
        const chain = ids(lookup(7, stackId), 2)
          .reverse()
          .map((frameId) => {
            const frame = lookup(6, frameId);
            const mapping = lookup(19, num(frame, 3));
            const filename = ids(mapping, 7)
              .map((id) => str(lookup(17, id), 2))
              .join('/');
            const isHermes = filename.startsWith('[Hermes ');
            hermes ||= isHermes;
            const nameId = num(frame, 2);
            const pc = num(frame, 4);
            const name =
              (nameId ? str(lookup(5, nameId), 2) : '') ||
              `0x${pc.toString(16)}`;
            let file = files.get(filename);
            if (!file) {
              file = { id: files.size, symbols: new Map() };
              files.set(filename, file);
            }
            if (!file.symbols.has(name))
              file.symbols.set(name, file.symbols.size);
            return bytes(
              3,
              message(
                // Hermes frames have no ELF addresses; don't export their interned IDs as PCs.
                uint(1, isHermes ? 0 : pc),
                uint(2, file.id),
                uint(3, file.symbols.get(name)!)
              )
            );
          });
        if (!chain.length) throw new Error('Sample has an empty callchain');
        if (hermes) hermesThreads.add(tid);
        samples.push({ time, tid, hermes, chain });
      }
    }
  };
  visit(trace);
  if (!samples.length) throw new Error('No stack samples to export');
  // Studio groups samples by TID, ignoring their different sampling sources.
  // Allocate presentation-only IDs after discovering every real TID to avoid collisions.
  const hermesTrackIds = new Map<bigint, bigint>();
  let nextTrackId = 0x7fffffffn;
  for (const tid of hermesThreads) {
    while (threads.has(nextTrackId)) nextTrackId--;
    if (nextTrackId <= 0n)
      throw new Error('No free thread ID for Hermes track');
    hermesTrackIds.set(tid, nextTrackId--);
  }
  const records: Buffer[] = [
    bytes(
      5,
      message(
        bytes(1, 'native-stack-samples'),
        bytes(1, 'hermes-wall-clock-samples')
      )
    ),
  ];
  records.push(
    ...samples
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
      .map((s) =>
        bytes(
          1,
          message(
            uint(1, s.time),
            uint(2, s.hermes ? hermesTrackIds.get(s.tid)! : s.tid),
            ...s.chain,
            uint(4, 1),
            uint(5, s.hermes ? 1 : 0)
          )
        )
      )
  );
  for (const [filename, file] of files) {
    records.push(
      bytes(
        3,
        message(
          uint(1, file.id),
          bytes(2, filename),
          ...[...file.symbols.keys()].map((name) => bytes(3, name))
        )
      )
    );
  }
  for (const [tid, pid] of threads) {
    records.push(
      bytes(
        4,
        message(
          uint(1, tid),
          uint(2, pid),
          bytes(
            3,
            hermesThreads.has(tid)
              ? `JS thread (native sampling, tid ${tid})`
              : tid === pid
              ? `Main (${tid})`
              : `Thread ${tid}`
          )
        )
      )
    );
  }
  for (const [tid, trackId] of hermesTrackIds) {
    records.push(
      bytes(
        4,
        message(
          uint(1, trackId),
          uint(2, threads.get(tid)!),
          bytes(3, `Hermes profiler (JS tid ${tid}, synthetic track)`)
        )
      )
    );
  }
  records.push(bytes(2, uint(1, samples.length)));
  const header = Buffer.alloc(12);
  header.write('SIMPLEPERF\0');
  header.writeUInt16LE(1, 10);
  return concat([
    header,
    ...records.flatMap((record) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(record.length);
      return [length, record];
    }),
    Buffer.alloc(4),
  ]);
}
