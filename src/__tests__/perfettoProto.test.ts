import {
  bytes,
  concat,
  fields,
  inspectNativeTrace,
  message,
  nativeCoverage,
  packet,
  tracePackets,
  uint,
  varint,
} from '../perfettoProto';

describe('perfettoProto', () => {
  it.each([
    0n,
    1n,
    127n,
    128n,
    300n,
    2n ** 31n,
    2n ** 53n + 1n,
    2n ** 64n - 1n,
  ])('round-trips varint %s', (value) => {
    const [field] = [...fields(uint(8, value))];
    expect(field).toEqual({ id: 8, value });
  });

  it('keeps nanosecond boot timestamps exact beyond Number precision', () => {
    const timestamp = 880116880688985123n;
    const [field] = [...fields(uint(8, timestamp))];
    expect(field!.value).toBe(timestamp);
  });

  it('rejects values outside uint64', () => {
    expect(() => varint(-1n)).toThrow('outside uint64');
    expect(() => varint(2n ** 64n)).toThrow('outside uint64');
  });

  it('decodes nested length-delimited messages', () => {
    const inner = message(uint(1, 42), bytes(2, 'hermes'));
    const outer = [...fields(bytes(66, inner))];
    expect(outer).toHaveLength(1);
    const decoded = [...fields(outer[0]!.value as Buffer)];
    expect(decoded[0]).toEqual({ id: 1, value: 42n });
    expect((decoded[1]!.value as Buffer).toString()).toBe('hermes');
  });

  it('rejects truncated payloads and varints', () => {
    const truncated = bytes(1, 'abcdef').subarray(0, 4);
    expect(() => [...fields(truncated)]).toThrow('truncated');
    expect(() => [...fields(Buffer.from([0x08, 0x80]))]).toThrow('varint');
  });

  it('rejects group wire types', () => {
    expect(() => [...fields(Buffer.from([0x0b]))]).toThrow();
  });
});

describe('tracePackets', () => {
  it('keeps the complete packets of a truncated trace', () => {
    const first = packet(uint(10, 1));
    const trace = concat([first, packet(uint(10, 2), bytes(66, 'sample'))]);
    const whole = tracePackets(trace);
    expect(whole.packets).toHaveLength(2);
    expect(whole.intactBytes).toBe(trace.length);
    expect(whole.damage).toBeUndefined();
    const cut = tracePackets(trace.subarray(0, trace.length - 1));
    expect(cut.packets).toEqual([uint(10, 1)]);
    expect(cut.intactBytes).toBe(first.length);
    expect(cut.damage).toMatch('truncated');
  });
});

// A ProfilingManager-shaped capture: service events and stats on sequence 1, samples
// on sequence 2 with MONOTONIC defaults. BOOTTIME = MONOTONIC + OFFSET.
const OFFSET = 10_000_000_000n;
const START = 1_000_000_000n; // MONOTONIC: JS recording 1 s → 11 s
const STOP = START + 10_000_000_000n;
const ms = (n: number) => BigInt(n) * 1_000_000n;
const session = {
  pid: 100,
  clockAnchors: [START, STOP].map((mono) => ({
    monotonicNs: String(mono),
    boottimeNs: String(mono + OFFSET),
  })),
};
function capture(
  options: {
    startMs?: number;
    stopMs?: number;
    durationMs?: number;
    sampleMs?: number[];
    stats?: Buffer[];
    extra?: Buffer[];
  } = {}
) {
  const service = (atMs: number, event: number) =>
    packet(
      uint(10, 1),
      uint(8, START + OFFSET + ms(atMs)),
      bytes(69, uint(event, 1))
    );
  return concat([
    packet(
      uint(10, 1),
      bytes(
        33,
        concat([
          bytes(2, bytes(1, bytes(111, bytes(15, uint(2, 100))))),
          uint(3, options.durationMs ?? 30000),
        ])
      )
    ),
    service(options.startMs ?? 30, 1),
    service(options.stopMs ?? 10_100, 5),
    packet(
      uint(87, 1),
      uint(10, 2),
      uint(13, 1),
      uint(42, 1),
      bytes(59, uint(58, 3))
    ),
    ...(options.sampleMs ?? [100, 5000, 9900]).map((at) =>
      packet(
        uint(10, 2),
        uint(8, START + ms(at)),
        bytes(66, message(uint(2, 100), uint(3, 101), uint(4, 1)))
      )
    ),
    ...(options.extra ?? []),
    packet(uint(10, 1), bytes(35, concat(options.stats ?? []))),
  ]);
}
const bufferStats = (...items: Buffer[]) =>
  bytes(1, concat([uint(12, 65536), ...items]));

describe('inspectNativeTrace', () => {
  it('reads sampling setup, lifecycle events and buffer stats', () => {
    const info = inspectNativeTrace(
      capture({ stats: [bufferStats(uint(18, 14), uint(6, 11))] })
    );
    expect(info).toMatchObject({
      sequence: 3,
      samplingFrequencyHz: 100,
      durationMs: 30000,
      startedNs: START + OFFSET + ms(30),
      stoppedNs: START + OFFSET + ms(10_100),
      droppedPacketEvents: 0, // previous_packet_dropped on a first packet is normal
      malformedPackets: 0,
      buffer: {
        sizeBytes: 65536,
        chunksDiscarded: 14,
        chunksOverwritten: 0,
        patchesFailed: 11,
        packetsLost: 0,
      },
    });
    expect(info.stackSampleCounts.get(100)).toBe(3);
  });

  it('counts a malformed sample instead of rejecting the capture', () => {
    // Regression: merge and analyze failed on one bad PerfSample payload.
    const info = inspectNativeTrace(
      capture({
        extra: [
          packet(
            uint(10, 2),
            uint(8, START),
            bytes(66, concat([uint(2, 100), Buffer.from([0x80])]))
          ),
        ],
      })
    );
    expect(info.stackSampleCounts.get(100)).toBe(3);
    expect(info.malformedPackets).toBe(1);
  });

  it('keeps the intact packets of a truncated trace', () => {
    const trace = capture();
    const info = inspectNativeTrace(trace.subarray(0, trace.length - 1));
    expect(info.stackSampleCounts.get(100)).toBe(3);
    expect(info.intactBytes).toBeLessThan(trace.length - 1);
    expect(info.totalBytes).toBe(trace.length - 1);
  });

  it('counts packets dropped after the first packet of a sequence', () => {
    const dropped = packet(
      uint(10, 2),
      uint(42, 1),
      uint(8, START + ms(200)),
      bytes(66, message(uint(2, 100), uint(3, 101), uint(4, 1)))
    );
    expect(
      inspectNativeTrace(capture({ extra: [dropped] })).droppedPacketEvents
    ).toBe(1);
  });

  it('rejects input that is not a Perfetto trace', () => {
    expect(() => inspectNativeTrace(Buffer.from('{"a":1}'))).toThrow(
      'Invalid native Perfetto trace'
    );
  });
});

describe('nativeCoverage', () => {
  const warnings = (trace: Buffer) =>
    nativeCoverage(inspectNativeTrace(trace), session).warnings;

  it('has nothing to report for a complete capture', () => {
    expect(warnings(capture())).toEqual([]);
  });

  it('reports a native buffer overflow and what the samples still cover', () => {
    expect(
      warnings(
        capture({
          sampleMs: [100, 2000, 4000],
          stats: [bufferStats(uint(18, 14), uint(6, 11))],
        })
      )
    ).toEqual([
      'Native trace buffer (64 KB) overflowed (14 buffer chunks discarded, 11 packet patches failed): native samples cover only 0.10 s to 4.00 s of the 10.0 s JS recording. Record with a larger bufferSizeKb',
    ]);
  });

  it('reports native sampling that stopped at durationMs before JS sampling', () => {
    expect(warnings(capture({ durationMs: 3000, stopMs: 3030 }))).toEqual([
      'Native sampling stopped 6.97 s before JS sampling ended: the last 6.97 s of the 10.0 s JS recording has no native samples. It ran for its full durationMs (3000 ms); record with a larger durationMs',
    ]);
  });

  it('falls back to the native result time without lifecycle events', () => {
    const trace = concat([
      packet(
        uint(87, 1),
        uint(10, 2),
        uint(13, 1),
        uint(8, START + OFFSET + ms(100))
      ),
    ]);
    expect(
      nativeCoverage(inspectNativeTrace(trace), {
        ...session,
        boundaries: {
          nativeResult: { boottimeNs: String(START + OFFSET + ms(4000)) },
        },
      }).warnings
    ).toEqual([
      'Native sampling stopped 6.00 s before JS sampling ended: the last 6.00 s of the 10.0 s JS recording has no native samples',
    ]);
  });

  it('reports native sampling that started late', () => {
    expect(warnings(capture({ startMs: 720 }))).toEqual([
      'Native sampling started 0.72 s after JS sampling: the first 0.72 s of the 10.0 s JS recording has no native samples (e.g. Android was still stopping a previous or cancelled capture)',
    ]);
  });

  it('leaves captures that never overlap JS sampling to the overlap warning', () => {
    expect(warnings(capture({ startMs: -9000, stopMs: -2000 }))).toEqual([]);
  });

  it('reports truncation and packets dropped mid-capture', () => {
    const trace = capture({
      extra: [packet(uint(10, 2), uint(42, 1), uint(8, START + ms(200)))],
    });
    // The cut-off last packet is the (empty) stats packet.
    const intact = trace.length - packet(uint(10, 1), bytes(35, '')).length;
    expect(warnings(trace.subarray(0, trace.length - 1))).toEqual([
      `Native trace is truncated or damaged after byte ${intact} of ${
        trace.length - 1
      }; only the packets before it were used`,
      'Native trace lost data (packets dropped mid-capture 1×); some native samples are missing',
    ]);
  });
});
