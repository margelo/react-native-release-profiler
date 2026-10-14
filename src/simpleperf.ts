import { ProfilerError } from './errors';
import { bytes, concat, message, uint } from './perfettoProto';
import type { ClockAnchor } from './mergeProfiles';
import { decodeStackSamples, type StackSample } from './traceSamples';

// Simpleperf report-sample --protobuf container and schema:
// https://android.googlesource.com/platform/system/extras/+/main/simpleperf/cmd_report_sample.proto
// This is a sampled-stack report, not raw perf.data or measured CPU durations.
export function toSimpleperf(
  trace: Buffer,
  anchors: ClockAnchor[]
): {
  trace: Buffer;
  skipped: Record<string, number>;
  /** The samples in the export. */
  samples: StackSample[];
} {
  const first = anchors[0];
  if (!first)
    throw new ProfilerError(
      'E_CLOCK',
      'Clock anchors are required for Simpleperf export'
    );
  const bootOffset = BigInt(first.boottimeNs) - BigInt(first.monotonicNs);
  const decoded = decodeStackSamples(trace);
  const skipped = { ...decoded.skipped };
  // Simpleperf times are CLOCK_MONOTONIC uint64. A BOOTTIME timestamp earlier than the
  // boot/monotonic offset (corrupt or mislabeled) has no such time: skip that sample.
  const exported = decoded.samples.filter((sample) => {
    const time = sample.timestamp - (sample.clock === 6 ? bootOffset : 0n);
    if (time >= 0n && time <= 0xffffffffffffffffn) return true;
    skipped['timestamp out of range'] =
      (skipped['timestamp out of range'] ?? 0) + 1;
    return false;
  });
  const files = new Map<string, { id: number; symbols: Map<string, number> }>();
  const threads = new Map<bigint, bigint>();
  const hermesThreads = new Set<bigint>();
  const samples = exported.map((sample) => {
    threads.set(sample.tid, sample.pid);
    if (sample.hermes) hermesThreads.add(sample.tid);
    const chain = sample.frames.map((frame) => {
      const isHermes = frame.file.startsWith('[Hermes ');
      let file = files.get(frame.file);
      if (!file) {
        file = { id: files.size, symbols: new Map() };
        files.set(frame.file, file);
      }
      if (!file.symbols.has(frame.name))
        file.symbols.set(frame.name, file.symbols.size);
      return bytes(
        3,
        message(
          // Hermes frames have no ELF addresses; don't export their interned IDs as PCs.
          uint(1, isHermes ? 0 : frame.pc),
          uint(2, file.id),
          uint(3, file.symbols.get(frame.name)!)
        )
      );
    });
    return {
      time: sample.timestamp - (sample.clock === 6 ? bootOffset : 0n),
      tid: sample.tid,
      hermes: sample.hermes,
      chain,
    };
  });
  if (!samples.length)
    throw new ProfilerError(
      'E_NO_NATIVE_SAMPLES',
      `No stack samples to export${
        Object.keys(skipped).length
          ? ` (skipped: ${JSON.stringify(skipped)})`
          : ''
      }`
    );
  // Studio groups samples by TID, ignoring their different sampling sources.
  // Allocate presentation-only IDs after discovering every real TID to avoid collisions.
  const hermesTrackIds = new Map<bigint, bigint>();
  let nextTrackId = 0x7fffffffn;
  for (const tid of hermesThreads) {
    while (threads.has(nextTrackId)) nextTrackId--;
    if (nextTrackId <= 0n)
      throw new ProfilerError(
        'E_TRACE_FORMAT',
        'No free thread ID for Hermes track'
      );
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
  const output = concat([
    header,
    ...records.flatMap((record) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(record.length);
      return [length, record];
    }),
    Buffer.alloc(4),
  ]);
  return { trace: output, skipped, samples: exported };
}
