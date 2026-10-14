import fs from 'fs';
import os from 'os';
import path from 'path';
import { SourceMapGenerator } from 'source-map';
import {
  assertSourceMapMatchesProfile,
  createClockMapper,
  mergeProfileBuffers,
  mergeSession,
  type HermesProfile,
  type ProfileSessionManifest,
} from '../mergeProfiles';
import { bytes, concat, message, packet, uint } from '../perfettoProto';
import { decodeStackSamples } from '../traceSamples';

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

describe('mergeProfileBuffers with damaged native traces', () => {
  const START = 248821050359334n;
  const STOP = START + 1_000_000_000n;
  const ms = (n: number) => BigInt(n) * 1_000_000n;
  const manifest = {
    version: 1,
    sessionId: 'session',
    pid: 100,
    hermesClock: 'monotonic',
    hermesProfilePath: 'hermes.cpuprofile',
    nativeProfilePath: 'native.perfetto-trace',
    nativeStatus: 'success',
    clockAnchors: [anchor(START), anchor(STOP)],
  } as ProfileSessionManifest;
  const generator = new SourceMapGenerator();
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 10, column: 0 },
    source: 'src/app.ts',
  });
  const sourceMap = generator.toString();
  const profile = {
    stackFrames: {
      1: { name: '[root]', category: 'root' },
      2: {
        name: 'work',
        category: 'JavaScript',
        parent: 1,
        line: 1,
        column: 1,
      },
    },
    samples: [100, 200, 300, 400].map((at) => ({
      ts: String((START + ms(at)) / 1000n),
      pid: 100,
      tid: 101,
      sf: 2,
    })),
  } as unknown as HermesProfile;
  const setup = packet(
    uint(10, 7),
    uint(13, 1),
    bytes(
      12,
      concat([
        bytes(17, message(uint(1, 1), bytes(2, 'libapp.so'))),
        bytes(19, message(uint(1, 1), uint(7, 1))),
        bytes(5, message(uint(1, 1), bytes(2, 'leaf'))),
        bytes(6, message(uint(1, 1), uint(2, 1), uint(3, 1), uint(4, 0x10))),
        bytes(7, message(uint(1, 1), uint(2, 1))),
      ])
    )
  );
  /** BOOTTIME sample at `at` ms into the session (or a raw timestamp). */
  const sample = (at: number, extra: Buffer[] = [], timestamp?: bigint) =>
    packet(
      uint(10, 7),
      uint(8, timestamp ?? START + OFFSET + ms(at)),
      ...extra,
      bytes(66, message(uint(2, 100), uint(3, 101), uint(4, 1)))
    );
  const merge = (native: Buffer) =>
    mergeProfileBuffers(native, profile, manifest, sourceMap);

  it('skips a malformed sample instead of rejecting the capture', async () => {
    // Regression: inspectNativeTrace threw E_TRACE_FORMAT before the decoder could skip it.
    const result = await merge(
      concat([
        setup,
        sample(150),
        packet(
          uint(10, 7),
          uint(8, START + OFFSET + ms(250)),
          bytes(66, concat([uint(2, 100), Buffer.from([0x80])]))
        ),
        sample(350),
      ])
    );
    expect(result.nativeSamples).toBe(2);
    expect(result.skippedNativeSamples).toEqual({ 'malformed sample': 1 });
    expect(result.nativeWarnings).toEqual([]);
  });

  it('ignores samples with an unsupported clock', async () => {
    const result = await merge(
      concat([setup, sample(150), sample(250, [uint(58, 1)])])
    );
    expect(result.nativeSamples).toBe(1);
    expect(result.skippedNativeSamples).toEqual({ 'unsupported clock 1': 1 });
  });

  it('merges the intact packets of a truncated trace', async () => {
    const native = concat([setup, sample(150), sample(250)]);
    const result = await merge(native.subarray(0, native.length - 1));
    expect(result.nativeSamples).toBe(1);
    // The Hermes packets must not be glued onto the cut-off native packet.
    const decoded = decodeStackSamples(result.trace);
    expect(decoded.skipped).toEqual({});
    expect(decoded.samples.filter((s) => s.hermes)).toHaveLength(4);
    expect(result.nativeWarnings).toEqual([
      `Native trace is truncated or damaged after byte ${
        native.length - sample(250).length
      } of ${native.length - 1}; only the packets before it were used`,
    ]);
  });

  it('reports the samples each output format actually holds', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-merge-'));
    try {
      const file = (name: string, data: string | Buffer) => {
        fs.writeFileSync(
          path.join(directory, name),
          typeof data === 'string' ? data : new Uint8Array(data)
        );
        return path.join(directory, name);
      };
      file('session.json', JSON.stringify(manifest));
      file('hermes.cpuprofile', JSON.stringify(profile));
      // One BOOTTIME timestamp before the boot/monotonic offset: Simpleperf can't place it.
      file(
        'native.perfetto-trace',
        concat([setup, sample(150), sample(250), sample(0, [], 1000n)])
      );
      const options = {
        session: path.join(directory, 'session.json'),
        sourceMap: file('app.map', sourceMap),
      };
      const simpleperf = await mergeSession({
        ...options,
        output: path.join(directory, 'out.trace'),
        format: 'simpleperf',
      });
      expect(simpleperf).toMatchObject({
        samples: 4,
        nativeSamples: 2,
        skippedSamples: { 'timestamp out of range': 1 },
      });
      const perfetto = await mergeSession({
        ...options,
        output: path.join(directory, 'out.perfetto-trace'),
        format: 'perfetto',
      });
      expect(perfetto).toMatchObject({
        samples: 4,
        nativeSamples: 3,
        skippedSamples: {},
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
