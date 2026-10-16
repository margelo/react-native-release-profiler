import { toFolded } from '../folded';
import type { StackSample } from '../traceSamples';

const PID = 1000n;
const sample = (
  tid: bigint,
  hermes: boolean,
  ...names: string[] // root first
): StackSample => ({
  timestamp: 1n,
  clock: 6,
  pid: PID,
  tid,
  hermes,
  frames: names
    .map((name) => ({
      name,
      file: hermes ? '[Hermes JavaScript]' : 'base.apk!libapp.so',
      pc: 0n,
    }))
    .reverse(),
});

/** Two captures of the same workload: only thread IDs differ. */
const capture = (pid: bigint, js: bigint, other: bigint) =>
  [
    sample(js, true, '[root]', 'work (src/work.ts:10)'),
    sample(js, true, '[root]', 'work (src/work.ts:10)'),
    sample(js, true, '[root]'),
    sample(js, false, 'start', 'hermesRun'),
    sample(pid, false, 'start', 'choreographer'),
    sample(other, false, 'start', 'gc'),
  ].map((s) => ({ ...s, pid }));

describe('toFolded', () => {
  it('separates Hermes wall-clock and native CPU samples and labels threads by role', () => {
    expect(toFolded(capture(PID, 1042n, 1077n), { nativeFrequencyHz: 100 }))
      .toBe(`JS (Hermes wall-clock samples);JS thread;[root] 1
JS (Hermes wall-clock samples);JS thread;[root];work (src/work.ts:10) 2
native (CPU samples at 100 Hz);JS thread;start [libapp.so];hermesRun [libapp.so] 1
native (CPU samples at 100 Hz);main thread;start [libapp.so];choreographer [libapp.so] 1
native (CPU samples at 100 Hz);tid 1077;start [libapp.so];gc [libapp.so] 1
`);
  });

  it('produces identical JS and main-thread stacks for captures with different thread IDs', () => {
    const lines = (folded: string) =>
      folded.split('\n').filter((line) => !line.includes(';tid '));
    expect(lines(toFolded(capture(2000n, 2042n, 2077n)))).toEqual(
      lines(toFolded(capture(PID, 1042n, 1077n)))
    );
  });

  it('names other threads when their name is known', () => {
    expect(
      toFolded([sample(1077n, false, 'run')], {
        threadNames: new Map([[1077, 'pool-2;thread-1']]),
      })
    ).toBe('native (CPU samples);pool-2,thread-1;run [libapp.so] 1\n');
  });

  it('picks the busiest Hermes thread as the JS thread', () => {
    const folded = toFolded([
      sample(1042n, true, '[root]'),
      sample(1042n, true, '[root]'),
      sample(1050n, true, '[root]'),
    ]);
    expect(folded).toBe(
      'JS (Hermes wall-clock samples);JS thread;[root] 2\n' +
        'JS (Hermes wall-clock samples);tid 1050;[root] 1\n'
    );
  });
});
