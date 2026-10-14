import { bytes, concat, fields, message, packet, uint } from '../perfettoProto';
import { toFolded } from '../folded';
import { toSimpleperf } from '../simpleperf';
import { decodeStackSamples } from '../traceSamples';
import type { WireField } from '../perfettoProto';

// Interned data: two frames (outer → leaf) in libapp.so, callstack 1 = [outer, leaf].
const entries = [
  bytes(17, message(uint(1, 1), bytes(2, 'libapp.so'))),
  bytes(19, message(uint(1, 1), uint(7, 1))),
  bytes(5, message(uint(1, 1), bytes(2, 'outer'))),
  bytes(5, message(uint(1, 2), bytes(2, 'leaf'))),
  bytes(6, message(uint(1, 1), uint(2, 1), uint(3, 1), uint(4, 0x10))),
  bytes(6, message(uint(1, 2), uint(2, 2), uint(3, 1), uint(4, 0x20))),
  bytes(7, message(uint(1, 1), uint(2, 1), uint(2, 2))),
];
const interned = bytes(12, concat(entries));
const SEQ = 7;
const setup = (data = interned) => packet(uint(10, SEQ), uint(13, 1), data);
const times = (samples: { timestamp: bigint }[]) =>
  samples.map((s) => s.timestamp);
const sample = (
  ts: number | undefined,
  options: { pid?: number; tid?: number; stack?: number; extra?: Buffer[] } = {}
) =>
  packet(
    uint(10, SEQ),
    ...(ts === undefined ? [] : [uint(8, ts)]),
    ...(options.extra ?? []),
    bytes(
      66,
      message(
        uint(2, options.pid ?? 100),
        uint(3, options.tid ?? 101),
        uint(4, options.stack ?? 1)
      )
    )
  );

describe('decodeStackSamples', () => {
  it('decodes interned stacks leaf first', () => {
    const { samples, skipped } = decodeStackSamples(
      concat([setup(), sample(1000)])
    );
    expect(skipped).toEqual({});
    expect(samples).toHaveLength(1);
    expect(samples[0]!.frames.map((f) => f.name)).toEqual(['leaf', 'outer']);
    expect(samples[0]).toMatchObject({ pid: 100n, tid: 101n, clock: 6 });
  });

  it('skips and counts bad samples instead of failing the whole trace', () => {
    const { samples, skipped } = decodeStackSamples(
      concat([
        setup(),
        sample(1000),
        sample(2000, { stack: 99 }), // unknown callstack
        sample(3000, { pid: 0 }),
        sample(undefined), // no timestamp
        packet(uint(10, SEQ), uint(8, 4000), bytes(66, Buffer.from([0x10]))),
        sample(5000),
      ])
    );
    expect(samples.map((s) => s.timestamp)).toEqual([1000n, 5000n]);
    expect(skipped).toEqual({
      'missing interned data': 1,
      'no process/thread ID': 1,
      'no timestamp': 1,
      'malformed sample': 1,
    });
  });

  it('keeps decoding after a dropped packet, skipping only samples whose interned data was lost', () => {
    // traced_perf interning IDs are never reused, so a drop only loses the entries the
    // dropped packets held (here: callstack 2).
    const dropped = sample(2000, { extra: [uint(42, 1)] });
    const { samples, skipped } = decodeStackSamples(
      concat([
        setup(),
        sample(1000),
        dropped,
        sample(3000),
        sample(3500, { stack: 2 }),
        sample(4000),
      ])
    );
    expect(times(samples)).toEqual([1000n, 2000n, 3000n, 4000n]);
    expect(skipped).toEqual({ 'missing interned data': 1 });
  });

  it('decodes captures whose first, clearing packet has previous_packet_dropped', () => {
    // Every real traced_perf capture starts like this (first_packet_on_sequence,
    // SEQ_INCREMENTAL_STATE_CLEARED and previous_packet_dropped on one packet).
    const first = packet(
      uint(87, 1),
      uint(10, SEQ),
      uint(13, 1),
      uint(42, 1),
      interned
    );
    const { samples, skipped } = decodeStackSamples(
      concat([first, sample(1000), sample(2000)])
    );
    expect(times(samples)).toEqual([1000n, 2000n]);
    expect(skipped).toEqual({});
  });

  it('skips only the minority sample when a thread disagrees on its pid', () => {
    // Regression: the first sample's (corrupt) pid used to win and drop every later
    // sample on the thread.
    const { samples, skipped } = decodeStackSamples(
      concat([setup(), sample(1000, { pid: 999 }), sample(2000), sample(3000)])
    );
    expect(times(samples)).toEqual([2000n, 3000n]);
    expect(samples.every((s) => s.pid === 100n)).toBe(true);
    expect(skipped).toEqual({ 'thread ID reused across processes': 1 });
  });

  it('drops only malformed interned entries', () => {
    // function_names entry whose iid is a truncated varint (fuzzed real capture).
    const broken = Buffer.from([0x2a, 0x02, 0x08, 0x80]);
    // A valid frame whose name (iid 3) is malformed: only samples using it are lost.
    const badName = bytes(5, concat([uint(1, 3), Buffer.from([0x12, 0x05])]));
    const frame3 = bytes(6, message(uint(1, 3), uint(2, 3), uint(3, 1)));
    const stack2 = bytes(7, message(uint(1, 2), uint(2, 1), uint(2, 3)));
    const { samples, skipped } = decodeStackSamples(
      concat([
        setup(bytes(12, concat([broken, ...entries, badName, frame3, stack2]))),
        sample(1000),
        sample(2000, { stack: 2 }),
        // interned_data cut off inside its last entry keeps the entries before it.
        packet(
          uint(10, SEQ),
          bytes(
            12,
            concat([
              bytes(7, message(uint(1, 4), uint(2, 2))),
              Buffer.from([0x2a, 0x05, 0x08]),
            ])
          )
        ),
        sample(3000, { stack: 4 }),
      ])
    );
    expect(times(samples)).toEqual([1000n, 3000n]);
    expect(samples[1]!.frames.map((f) => f.name)).toEqual(['leaf']);
    expect(skipped).toEqual({ 'missing interned data': 1 });
  });

  it('skips only samples that rely on malformed packet defaults', () => {
    const defaults = (data: Buffer) => packet(uint(10, SEQ), bytes(59, data));
    const { samples, skipped } = decodeStackSamples(
      concat([
        setup(),
        defaults(Buffer.from([0xd0, 0x03, 0x80])), // timestamp_clock_id: truncated
        sample(1000),
        sample(2000, { extra: [uint(58, 3)] }), // explicit clock
        defaults(uint(58, 3)),
        sample(3000),
      ])
    );
    expect(samples.map((s) => [s.timestamp, s.clock])).toEqual([
      [2000n, 3],
      [3000n, 3],
    ]);
    expect(skipped).toEqual({ 'unknown clock (malformed packet defaults)': 1 });
  });

  it('keeps the complete packets of a truncated trace', () => {
    const trace = concat([setup(), sample(1000), sample(2000)]);
    const { samples, skipped } = decodeStackSamples(
      trace.subarray(0, trace.length - 1)
    );
    expect(times(samples)).toEqual([1000n]);
    expect(skipped).toEqual({ 'truncated or damaged packet': 1 });
  });

  it('skips malformed packets and compressed packets', () => {
    const { samples, skipped } = decodeStackSamples(
      concat([
        setup(),
        bytes(1, Buffer.from([0x08, 0x80])), // packet with a truncated varint
        packet(uint(10, SEQ), bytes(50, Buffer.from('not zlib'))),
        sample(1000),
      ])
    );
    expect(times(samples)).toEqual([1000n]);
    expect(skipped).toEqual({
      'malformed packet': 1,
      'malformed compressed packets': 1,
    });
  });

  it('rejects input that is not a Perfetto trace', () => {
    expect(() => decodeStackSamples(Buffer.from('{"traceEvents":[]}'))).toThrow(
      'Expected Perfetto trace packets'
    );
  });
});

// A native capture shaped like traced_perf's (MONOTONIC defaults, a real mapping path)
// plus a Hermes track shaped like the merger's: JS thread 101, main thread 100.
const mixedTrace = () =>
  concat([
    packet(
      uint(10, 7),
      uint(13, 1),
      bytes(59, uint(58, 3)),
      bytes(
        12,
        concat([
          bytes(17, message(uint(1, 1), bytes(2, 'data'))),
          bytes(17, message(uint(1, 2), bytes(2, 'app'))),
          bytes(17, message(uint(1, 3), bytes(2, 'base.apk!libapp.so'))),
          bytes(19, message(uint(1, 1), uint(7, 1), uint(7, 2), uint(7, 3))),
          ...entries.slice(2),
        ])
      )
    ),
    ...[
      [900, 101],
      [2000, 100],
    ].map(([ts, tid]) =>
      packet(
        uint(10, 7),
        uint(8, ts!),
        bytes(66, message(uint(2, 100), uint(3, tid!), uint(4, 1)))
      )
    ),
    packet(
      uint(10, 8),
      uint(13, 1),
      bytes(
        12,
        concat([
          bytes(17, message(uint(1, 1), bytes(2, '[Hermes JavaScript]'))),
          bytes(19, message(uint(1, 1), uint(7, 1))),
          bytes(5, message(uint(1, 1), bytes(2, 'render'))),
          bytes(5, message(uint(1, 2), bytes(2, 'a;b'))),
          bytes(6, message(uint(1, 1), uint(2, 1), uint(3, 1), uint(4, 1))),
          bytes(6, message(uint(1, 2), uint(2, 2), uint(3, 1), uint(4, 2))),
          bytes(7, message(uint(1, 1), uint(2, 1), uint(2, 2))),
        ])
      )
    ),
    packet(
      uint(10, 8),
      uint(8, 1500),
      uint(58, 6),
      bytes(66, message(uint(2, 100), uint(3, 101), uint(4, 1)))
    ),
  ]);

/** Records of a Simpleperf report-sample file, as decoded protobuf fields. */
const simpleperfRecords = (output: Buffer) => {
  const records: { type: number; fields: WireField[] }[] = [];
  for (let offset = 12; ; ) {
    const length = output.readUInt32LE(offset);
    offset += 4;
    if (!length) break;
    const [record] = [...fields(output.subarray(offset, offset + length))];
    records.push({
      type: record!.id,
      fields: [...fields(record!.value as Buffer)],
    });
    offset += length;
  }
  return records;
};
const value = (items: WireField[], id: number) =>
  items.find((item) => item.id === id)?.value;
const text = (items: WireField[], id: number) =>
  items
    .filter((item) => item.id === id)
    .map((item) => (item.value as Buffer).toString());

describe('toSimpleperf', () => {
  it('exports the valid samples and reports skipped ones', () => {
    const anchors = [{ monotonicNs: '0', boottimeNs: '500' }];
    const { trace, skipped } = toSimpleperf(
      concat([setup(), sample(1000), sample(2000, { stack: 99 })]),
      anchors
    );
    expect(trace.subarray(0, 10).toString()).toBe('SIMPLEPERF');
    expect(skipped).toEqual({ 'missing interned data': 1 });
  });

  it('exports clock-converted times, real PCs only for native frames, files and tracks', () => {
    const { trace, samples } = toSimpleperf(mixedTrace(), [
      { monotonicNs: '0', boottimeNs: '500' },
    ]);
    expect(samples).toHaveLength(3);
    const records = simpleperfRecords(trace);
    expect(
      records
        .filter((r) => r.type === 1)
        .map((r) => ({
          time: value(r.fields, 1),
          thread: value(r.fields, 2),
          pcs: r.fields
            .filter((f) => f.id === 3)
            .map((f) => value([...fields(f.value as Buffer)], 1)),
          type: value(r.fields, 5),
        }))
    ).toEqual([
      { time: 900n, thread: 101n, pcs: [0x20n, 0x10n], type: 0n },
      // BOOTTIME 1500 − (boot − mono = 500); Hermes interned IDs are not PCs.
      { time: 1000n, thread: 0x7fffffffn, pcs: [0n, 0n], type: 1n },
      { time: 2000n, thread: 100n, pcs: [0x20n, 0x10n], type: 0n },
    ]);
    expect(
      records
        .filter((r) => r.type === 3)
        .map((r) => [text(r.fields, 2)[0], text(r.fields, 3)])
    ).toEqual([
      ['data/app/base.apk!libapp.so', ['leaf', 'outer']],
      ['[Hermes JavaScript]', ['a;b', 'render']],
    ]);
    expect(
      records
        .filter((r) => r.type === 4)
        .map((r) => [
          value(r.fields, 1),
          value(r.fields, 2),
          text(r.fields, 3)[0],
        ])
    ).toEqual([
      [101n, 100n, 'JS thread (native sampling, tid 101)'],
      [100n, 100n, 'Main (100)'],
      [0x7fffffffn, 100n, 'Hermes profiler (JS tid 101, synthetic track)'],
    ]);
  });

  it('skips a BOOTTIME sample earlier than the boot offset instead of failing', () => {
    // Regression: one such sample aborted the export ("outside uint64 range").
    const { samples, skipped } = toSimpleperf(
      concat([setup(), sample(1000), sample(9000)]),
      [{ monotonicNs: '0', boottimeNs: '5000' }]
    );
    expect(times(samples)).toEqual([9000n]);
    expect(skipped).toEqual({ 'timestamp out of range': 1 });
  });

  it('fails clearly when no sample is usable', () => {
    expect(() =>
      toSimpleperf(concat([setup(), sample(1000, { stack: 99 })]), [
        { monotonicNs: '0', boottimeNs: '0' },
      ])
    ).toThrow('No stack samples to export (skipped:');
  });
});

describe('toFolded', () => {
  it('collapses identical stacks with sample counts', () => {
    const { samples } = decodeStackSamples(
      concat([setup(), sample(1000), sample(2000), sample(3000, { tid: 100 })])
    );
    expect(toFolded(samples)).toBe(
      'native tid 100 (main);outer [libapp.so];leaf [libapp.so] 1\n' +
        'native tid 101;outer [libapp.so];leaf [libapp.so] 2\n'
    );
  });

  it('labels the Hermes track and the JS thread, escapes ";" and names libraries', () => {
    expect(toFolded(decodeStackSamples(mixedTrace()).samples)).toBe(
      'JS (Hermes) tid 101;render;a,b 1\n' +
        'native tid 100 (main);outer [libapp.so];leaf [libapp.so] 1\n' +
        'native tid 101 (JS thread);outer [libapp.so];leaf [libapp.so] 1\n'
    );
  });
});
