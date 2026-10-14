import { analyzeProfiles } from '../analyze';
import type { ProfilerError } from '../errors';
import type { HermesProfile, ProfileSessionManifest } from '../mergeProfiles';
import { bytes, concat, message, packet, uint } from '../perfettoProto';
import type { SymbolicatedFrame } from '../symbolicate';

// Hermes: one sample every 10 ms from MONOTONIC 1.000 s; BOOTTIME runs 1000 s ahead.
const OFFSET = 1_000_000_000_000n;
const MS = 1_000_000n;
const mono = (ms: number) => 1_000_000_000n + BigInt(ms) * MS;
const frames = new Map<string, SymbolicatedFrame>([
  ['1', { name: '[root]', function: '[root]', functionId: 'r', kind: 'root' }],
  [
    '2',
    {
      name: 'task (src/app.ts:12:5)',
      function: 'task',
      functionId: '1:400',
      functionLine: 10,
      kind: 'js',
      source: 'src/app.ts',
      line: 12,
      column: 5,
    },
  ],
]);
// 3 idle, 10 busy (30–130 ms), 7 idle.
const pattern = 'iii' + 'b'.repeat(10) + 'iiiiiii';
const profile = (pid = 1): HermesProfile =>
  ({
    stackFrames: {
      1: { name: '[root]', category: 'root' },
      2: { name: 'task', category: 'JavaScript', parent: 1 },
    },
    samples: [...pattern].map((c, i) => ({
      ts: String((mono(i * 10) / 1000n).toString()),
      pid,
      tid: 2,
      sf: c === 'b' ? 2 : 1,
    })),
  } as unknown as HermesProfile);
const anchor = (ms: number, drift = 0n) => ({
  monotonicNs: String(mono(ms)),
  boottimeNs: String(mono(ms) + OFFSET + drift),
  uncertaintyNs: '1000',
});
const manifest = (
  overrides: Partial<ProfileSessionManifest> = {}
): ProfileSessionManifest => ({
  version: 1,
  sessionId: 'session-1',
  pid: 1,
  hermesClock: 'monotonic',
  hermesProfilePath: 'hermes.cpuprofile',
  nativeProfilePath: 'native.perfetto-trace',
  nativeStatus: 'success',
  clockAnchors: [anchor(-5), anchor(200)],
  boundaries: {
    nativeRequest: anchor(-100),
    hermesStart: anchor(-5),
    nativeResult: anchor(210),
  },
  ...overrides,
});

// One interned native frame `nativeWork` in libapp.so.
const SEQ = 7;
const setup = packet(
  uint(10, SEQ),
  uint(13, 1),
  bytes(
    12,
    concat([
      bytes(17, message(uint(1, 1), bytes(2, 'libapp.so'))),
      bytes(19, message(uint(1, 1), uint(7, 1))),
      bytes(5, message(uint(1, 1), bytes(2, 'nativeWork'))),
      bytes(6, message(uint(1, 1), uint(2, 1), uint(3, 1), uint(4, 0x10))),
      bytes(7, message(uint(1, 1), uint(2, 1))),
    ])
  )
);
/** A native sample at `ms` (BOOTTIME by default, or MONOTONIC with clock 3). */
const native = (ms: number, pid: number, tid: number, clock?: 3) =>
  packet(
    uint(10, SEQ),
    uint(8, clock ? mono(ms) : mono(ms) + OFFSET),
    ...(clock ? [uint(58, clock)] : []),
    bytes(66, message(uint(2, pid), uint(3, tid), uint(4, 1)))
  );
const trace = (...samples: Buffer[]) => concat([setup, ...samples]);

const run = (
  options: {
    manifest?: ProfileSessionManifest;
    nativeTrace?: Buffer;
    profile?: HermesProfile;
  } = {}
) =>
  analyzeProfiles({
    profile: options.profile ?? profile(),
    frames,
    symbolicatedFrames: 1,
    unmappedFrames: 0,
    manifest: options.manifest ?? manifest(),
    nativeTrace: options.nativeTrace,
    longTaskMs: 50,
    top: 10,
    root: '/project',
  });
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as ProfilerError).code;
  }
  return undefined;
};

describe('analyze native correlation', () => {
  const report = run({
    nativeTrace: trace(
      native(-50, 1, 2), // startup: before Hermes sampling started
      native(60, 1, 2), // JS thread during the task (BOOTTIME)
      native(70, 1, 2, 3), // JS thread during the task (MONOTONIC)
      native(80, 1, 3), // another thread during the task
      native(122, 1, 2), // JS thread after the last busy sample, before the task ended
      native(90, 5, 50), // another process
      native(170, 1, 2) // JS thread after the task
    ),
  });

  it('attributes native samples on the JS thread to the task they fall in', () => {
    const [task] = report.js.longTasks;
    expect(task).toMatchObject({ startMs: 25, durationMs: 100 });
    expect(task!.nativeOnJsThreadSamples).toBe(3);
    expect(task!.nativeOnJsThread).toEqual([
      { frame: 'nativeWork', library: 'libapp.so', samples: 3 },
    ]);
    expect(task!.nativeLibrariesOnJsThread).toEqual([
      { library: 'libapp.so', samples: 3 },
    ]);
  });

  it("counts only the app's samples and reports startup samples separately", () => {
    expect(report.quality.nativeSamples).toBe(6);
    expect(report.quality.overlappingNativeSamples).toBe(5);
    expect(report.native.samples).toBe(5);
    expect(report.native.threads).toEqual([
      { tid: 2, label: 'JS thread', samples: 4, pct: 80 },
      { tid: 3, label: 'thread', samples: 1, pct: 20 },
    ]);
    expect(report.native.beforeJs).toMatchObject({
      samples: 1,
      spanMs: 0,
      gapToJsMs: 45,
      threads: [{ tid: 2, label: 'JS thread', samples: 1, pct: 100 }],
    });
  });

  it('warns when native sampling ended before JS sampling started', () => {
    const late = run({ nativeTrace: trace(native(-50, 1, 2)) });
    expect(late.quality.overlappingNativeSamples).toBe(0);
    expect(late.native.beforeJs?.samples).toBe(1);
    expect(late.quality.warnings.join('\n')).toContain(
      'No native samples overlap'
    );
  });

  it('analyzes JS only when the native trace has no samples for the app', () => {
    const empty = run({ nativeTrace: trace() });
    expect(empty.quality.nativeSamples).toBe(0);
    expect(empty.quality.warnings.join('\n')).toContain(
      'no stack samples for this app'
    );
    expect(empty.js.longTasks).toHaveLength(1);
  });
});

describe('analyze session consistency (same checks as merge)', () => {
  it("rejects another process's native trace", () => {
    expect(codeOf(() => run({ nativeTrace: trace(native(60, 5, 50)) }))).toBe(
      'E_WRONG_NATIVE_TRACE'
    );
  });

  it('rejects a native trace recorded outside the session', () => {
    expect(
      codeOf(() => run({ nativeTrace: trace(native(100_000, 1, 2)) }))
    ).toBe('E_WRONG_NATIVE_TRACE');
  });

  it('rejects a capture during which the device suspended', () => {
    expect(
      codeOf(() =>
        run({
          manifest: manifest({
            clockAnchors: [anchor(-5), anchor(200, 3_000_000_000n)],
          }),
        })
      )
    ).toBe('E_CLOCK');
  });

  it('rejects a Hermes profile from another process', () => {
    expect(codeOf(() => run({ profile: profile(7) }))).toBe('E_HERMES_PROFILE');
  });

  it('rejects Hermes samples outside the session', () => {
    expect(
      codeOf(() =>
        run({
          manifest: manifest({ clockAnchors: [anchor(500), anchor(900)] }),
        })
      )
    ).toBe('E_CLOCK');
  });

  it('rejects unsupported manifests', () => {
    expect(
      codeOf(() =>
        run({
          manifest: {
            ...manifest(),
            version: 2,
          } as unknown as ProfileSessionManifest,
        })
      )
    ).toBe('E_SESSION_MANIFEST');
  });
});
