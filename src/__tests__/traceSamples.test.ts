import { bytes, concat, message, packet, uint } from '../perfettoProto';
import { toFolded } from '../folded';
import { toSimpleperf } from '../simpleperf';
import { decodeStackSamples } from '../traceSamples';

// Interned data: two frames (outer → leaf) in libapp.so, callstack 1 = [outer, leaf].
const interned = bytes(
  12,
  concat([
    bytes(17, message(uint(1, 1), bytes(2, 'libapp.so'))),
    bytes(19, message(uint(1, 1), uint(7, 1))),
    bytes(5, message(uint(1, 1), bytes(2, 'outer'))),
    bytes(5, message(uint(1, 2), bytes(2, 'leaf'))),
    bytes(6, message(uint(1, 1), uint(2, 1), uint(3, 1), uint(4, 0x10))),
    bytes(6, message(uint(1, 2), uint(2, 2), uint(3, 1), uint(4, 0x20))),
    bytes(7, message(uint(1, 1), uint(2, 1), uint(2, 2))),
  ])
);
const SEQ = 7;
const setup = () => packet(uint(10, SEQ), uint(13, 1), interned);
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

  it('distrusts interned state after dropped packets until it is cleared', () => {
    const dropped = sample(2000, { extra: [uint(42, 1)] });
    const { samples, skipped } = decodeStackSamples(
      concat([
        setup(),
        sample(1000),
        dropped,
        sample(3000),
        setup(),
        sample(4000),
      ])
    );
    expect(samples.map((s) => s.timestamp)).toEqual([1000n, 4000n]);
    expect(skipped).toEqual({ 'interned state lost after dropped packets': 2 });
  });
});

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
});
