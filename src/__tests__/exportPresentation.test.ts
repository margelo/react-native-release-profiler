import { SourceMapGenerator } from 'source-map';
import {
  functionFrameNames,
  mergeProfileBuffers,
  type HermesProfile,
  type ProfileSessionManifest,
} from '../mergeProfiles';
import {
  bytes,
  concat,
  fields,
  message,
  packet,
  uint,
  type WireField,
} from '../perfettoProto';
import { toSimpleperf } from '../simpleperf';
import type { SymbolicatedFrame } from '../symbolicate';
import { decodeStackSamples } from '../traceSamples';

const PID = 100;
const JS_TID = 101;
const OFFSET = 5_000_000_000n; // BOOTTIME - MONOTONIC
const anchors = [
  { monotonicNs: '1000000000', boottimeNs: String(1_000_000_000n + OFFSET) },
  { monotonicNs: '2000000000', boottimeNs: String(2_000_000_000n + OFFSET) },
];
const manifest: ProfileSessionManifest = {
  version: 1,
  packageName: 'com.example.app',
  sessionId: 'session',
  pid: PID,
  hermesClock: 'monotonic',
  hermesProfilePath: 'hermes.cpuprofile',
  nativeProfilePath: 'native.perfetto-trace',
  nativeStatus: 'success',
  clockAnchors: anchors,
};

// Native trace: one stack sample on the main thread inside the session.
const nativeTrace = concat([
  packet(
    uint(10, 1),
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
  ),
  packet(
    uint(10, 1),
    uint(8, 1_500_000_000n + OFFSET),
    bytes(66, message(uint(2, PID), uint(3, PID), uint(4, 1)))
  ),
]);

// `work` starts at bytecode 100 (src/work.ts:10); Hermes sampled it at two offsets, so it
// has two stack-frame nodes (lines 12 and 14).
const generator = new SourceMapGenerator();
for (const [column, line] of [
  [100, 10],
  [105, 12],
  [109, 14],
] as const)
  generator.addMapping({
    generated: { line: 1, column },
    original: { line, column: 0 },
    source: 'src/work.ts',
  });
const sourceMap = JSON.stringify({
  ...JSON.parse(generator.toString()),
  x_hermes_function_offsets: { 0: [0, 100] },
});

const profile: HermesProfile = {
  traceEvents: [
    {
      name: 'thread_name',
      ph: 'M',
      pid: PID,
      tid: String(JS_TID),
      args: { name: 'mqt_v_js' },
    },
    // Another process's thread is not this app's.
    { name: 'thread_name', ph: 'M', pid: 7, tid: '8', args: { name: 'x' } },
  ],
  stackFrames: {
    1: { name: '[root]', category: 'root' },
    2: {
      name: 'work',
      category: 'JavaScript',
      funcVirtAddr: '100',
      offset: '5',
      parent: 1,
    },
    3: {
      name: 'work',
      category: 'JavaScript',
      funcVirtAddr: '100',
      offset: '9',
      parent: 1,
    },
  },
  samples: [1_100_000, 1_110_000, 1_120_000].map((ts, i) => ({
    ts: String(ts),
    pid: PID,
    tid: String(JS_TID),
    sf: i === 2 ? 3 : 2,
  })),
};

const merge = (session = manifest) =>
  mergeProfileBuffers(nativeTrace, profile, session, sourceMap);

const packets = (trace: Buffer): WireField[][] =>
  [...fields(trace)].map((top) => [...fields(top.value as Buffer)]);
const nested = (items: WireField[], id: number) =>
  items
    .filter((item) => item.id === id && Buffer.isBuffer(item.value))
    .map((item) => [...fields(item.value as Buffer)]);
const scalar = (items: WireField[], id: number) =>
  items.find((item) => item.id === id)?.value;
const text = (items: WireField[], id: number) =>
  (scalar(items, id) as Buffer | undefined)?.toString();

describe('Perfetto export presentation', () => {
  it('names one frame per JS function, at its definition line', async () => {
    const { trace, samples } = await merge();
    const hermes = decodeStackSamples(trace).samples.filter((s) => s.hermes);
    expect(samples).toBe(3);
    expect(hermes).toHaveLength(3);
    const leaves = hermes.map((s) => s.frames[0]!);
    expect(leaves.map((f) => f.name)).toEqual([
      'work (src/work.ts:10)',
      'work (src/work.ts:10)',
      'work (src/work.ts:10)',
    ]);
    // One interned frame, so Perfetto and Android Studio see one function.
    expect(new Set(leaves.map((f) => f.pc)).size).toBe(1);
  });

  it('names the app process, its main thread and the JS thread', async () => {
    const { trace } = await merge();
    const trees = packets(trace).flatMap((p) => nested(p, 2));
    expect(trees).toHaveLength(1);
    const processes = nested(trees[0]!, 1).map((p) => [
      Number(scalar(p, 1)),
      text(p, 3),
    ]);
    const threads = nested(trees[0]!, 2).map((t) => [
      Number(scalar(t, 1)),
      text(t, 2),
      Number(scalar(t, 3)),
    ]);
    expect(processes).toEqual([[PID, 'com.example.app']]);
    expect(threads).toEqual([
      [PID, 'main', PID],
      [JS_TID, 'mqt_v_js', PID],
    ]);
  });

  it('still names threads when the session has no package name', async () => {
    const { packageName, ...unnamed } = manifest;
    const { trace } = await merge(unnamed);
    const tree = packets(trace).flatMap((p) => nested(p, 2))[0]!;
    expect(nested(tree, 1)).toEqual([]);
    expect(nested(tree, 2).map((t) => text(t, 2))).toEqual([
      'main',
      'mqt_v_js',
    ]);
    expect(packageName).toBeDefined();
  });

  it('gives Hermes samples a counter value so Perfetto shows the session name', async () => {
    const { trace } = await merge();
    const perfSamples = packets(trace).flatMap((p) => nested(p, 66));
    const hermes = perfSamples.filter((s) => Number(scalar(s, 3)) === JS_TID);
    expect(hermes).toHaveLength(3);
    expect(hermes.map((s) => scalar(s, 6))).toEqual([1n, 1n, 1n]);
    // The native sample is unchanged.
    expect(
      perfSamples
        .filter((s) => Number(scalar(s, 3)) === PID)
        .map((s) => scalar(s, 6))
    ).toEqual([undefined]);
  });

  it('exports one Simpleperf symbol per JS function', async () => {
    const { trace } = await merge();
    const simpleperf = toSimpleperf(trace, anchors).trace;
    const symbols: Record<string, string[]> = {};
    for (let offset = 12; ; ) {
      const length = simpleperf.readUInt32LE(offset);
      offset += 4;
      if (!length) break;
      const record = simpleperf.subarray(offset, offset + length);
      offset += length;
      for (const file of nested([...fields(record)], 3))
        symbols[text(file, 2)!] = file
          .filter((f) => f.id === 3)
          .map((f) => (f.value as Buffer).toString());
    }
    expect(symbols['[Hermes JavaScript]']).toEqual(['work (src/work.ts:10)']);
  });
});

describe('functionFrameNames', () => {
  const js = (
    functionId: string,
    fn: string,
    line: number,
    functionLine?: number,
    functionColumn?: number
  ): SymbolicatedFrame => ({
    name: `${fn} (lib.js:${line}:3)`,
    function: fn,
    functionId,
    functionLine,
    functionColumn,
    kind: 'js',
    source: 'lib.js',
    line,
    column: 3,
  });

  it('keeps different functions defined on one line apart', () => {
    const names = functionFrameNames(
      new Map([
        ['1', js('1:10', '(anonymous)', 8, 8, 11)],
        ['2', js('1:10', '(anonymous)', 9, 8, 11)],
        ['3', js('1:90', '(anonymous)', 8, 8, 91)],
        ['4', js('1:200', 'named', 20, 18, 1)],
      ])
    );
    expect([...names.values()]).toEqual([
      '(anonymous) (lib.js:8:11)',
      '(anonymous) (lib.js:8:11)',
      '(anonymous) (lib.js:8:91)',
      'named (lib.js:18)',
    ]);
  });

  it('leaves native frames and frames without a definition line as they are', () => {
    const native: SymbolicatedFrame = {
      name: '[Native] jsonParse',
      function: '[Native] jsonParse',
      functionId: '[Native] jsonParse',
      kind: 'native',
    };
    const names = functionFrameNames(
      new Map([
        ['1', native],
        ['2', js('1:5', 'f', 4)],
      ])
    );
    expect([...names.values()]).toEqual([
      '[Native] jsonParse',
      'f (lib.js:4:3)',
    ]);
  });
});
