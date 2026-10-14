import {
  assertSourceMapMatchesProfile,
  createClockMapper,
  type HermesProfile,
} from '../mergeProfiles';

const OFFSET = 631295832477363n;
const anchor = (mono: bigint, uncertainty = 5000n, drift = 0n) => ({
  monotonicNs: String(mono),
  boottimeNs: String(mono + OFFSET + drift),
  uncertaintyNs: String(uncertainty),
});

describe('createClockMapper', () => {
  const start = 248821050359334n;
  const stop = start + 5_000_000_000n;

  it('maps Hermes microseconds to boottime nanoseconds', () => {
    const map = createClockMapper([anchor(start), anchor(stop)]);
    const us = (start + 1_234_567_000n) / 1000n;
    expect(map(String(us))).toBe(us * 1000n + OFFSET);
  });

  it('accepts samples within 1 ms of the anchors', () => {
    const map = createClockMapper([anchor(start), anchor(stop)]);
    expect(() => map(String((start - 900_000n) / 1000n))).not.toThrow();
    expect(() => map(String((stop + 900_000n) / 1000n))).not.toThrow();
  });

  it('rejects samples from outside the session', () => {
    const map = createClockMapper([anchor(start), anchor(stop)]);
    expect(() => map(String((stop + 5_000_000n) / 1000n))).toThrow(
      'outside session clock anchors'
    );
  });

  it('rejects suspend or clock changes between anchors', () => {
    expect(() =>
      createClockMapper([anchor(start), anchor(stop, 5000n, 5_000_000n)])
    ).toThrow('Device suspended');
  });

  it('rejects imprecise anchors', () => {
    expect(() =>
      createClockMapper([anchor(start, 2_000_000n), anchor(stop)])
    ).toThrow('uncertainty exceeds 1 ms');
  });

  it('requires two anchors', () => {
    expect(() => createClockMapper([anchor(start)])).toThrow(
      'At least start and stop'
    );
  });

  it('is independent of anchor order', () => {
    const map = createClockMapper([anchor(stop), anchor(start)]);
    expect(map(String(start / 1000n))).toBe((start / 1000n) * 1000n + OFFSET);
  });
});

describe('assertSourceMapMatchesProfile', () => {
  const profile = (...addresses: number[]): HermesProfile => ({
    samples: [],
    stackFrames: Object.fromEntries(
      addresses.map((address, index) => [
        String(index + 1),
        { name: `f${index}`, funcVirtAddr: String(address), offset: '4' },
      ])
    ),
  });
  // Real maps list the global function at 0 but not the Metro prelude functions after it.
  const map = { x_hermes_function_offsets: { 0: [0, 16670, 400791, 400909] } };

  it('accepts a profile from the same build', () => {
    expect(() =>
      assertSourceMapMatchesProfile(map, profile(400791, 400909))
    ).not.toThrow();
  });

  it('ignores Metro prelude functions before the first listed offset', () => {
    // Regression: R8 capture sampled 5 prelude functions and 10 app functions.
    expect(() =>
      assertSourceMapMatchesProfile(
        map,
        profile(5177, 1585, 1982, 4922, 1288, 400791, 400909)
      )
    ).not.toThrow();
  });

  it('rejects a source map from a different build', () => {
    expect(() =>
      assertSourceMapMatchesProfile(map, profile(400792, 401000, 500000))
    ).toThrow('Source map does not match the profiled build: only 0 of 3');
  });

  it('rejects a debug (source-position) profile with a release map', () => {
    const debug = {
      samples: [],
      stackFrames: {
        1: { name: 'f', category: 'JavaScript', line: '120', column: '4' },
      },
    } as unknown as HermesProfile;
    expect(() => assertSourceMapMatchesProfile(map, debug)).toThrow(
      'debug build'
    );
  });

  it('skips the check for maps without Hermes function offsets', () => {
    expect(() =>
      assertSourceMapMatchesProfile({}, profile(1, 2, 3))
    ).not.toThrow();
  });
});
