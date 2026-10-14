import type { StackSample } from './traceSamples';

const clean = (name: string) => name.replace(/;/g, ',').trim();
export const libraryName = (file: string) =>
  file.split('!').pop()!.split('/').pop()! || file;

export interface FoldedOptions {
  /** Effective native sampling frequency, shown in the native track label. */
  nativeFrequencyHz?: number;
  /** Known thread names by tid (e.g. from the Hermes profile) for threads without a role. */
  threadNames?: Map<number, string>;
}

/** Collapsed stacks (`kind;thread;root;…;leaf count`), the format flamegraph.pl and
 * speedscope read. Plain text, so agents can grep and diff it directly.
 *
 * One count is one sample, but the two kinds measure different things: Hermes samples
 * are wall-clock (idle `[root]` included) and native samples are on-CPU at the native
 * frequency. Each kind is its own top-level frame, labelled with its unit. Threads are
 * named by role (`JS thread`, `main thread`), not by tid, so the files of two captures of
 * the same workload share stacks and can be diffed.
 */
export function toFolded(
  samples: StackSample[],
  options: FoldedOptions = {}
): string {
  // The JS thread is the non-main thread with the most Hermes samples.
  const hermesSamples = new Map<bigint, number>();
  for (const sample of samples)
    if (sample.hermes && sample.tid !== sample.pid)
      hermesSamples.set(sample.tid, (hermesSamples.get(sample.tid) ?? 0) + 1);
  const jsThread = [...hermesSamples].sort(
    ([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1)
  )[0]?.[0];
  const thread = (sample: StackSample) =>
    sample.tid === sample.pid
      ? 'main thread'
      : sample.tid === jsThread
      ? 'JS thread'
      : clean(
          options.threadNames?.get(Number(sample.tid)) ?? `tid ${sample.tid}`
        );
  const native = `native (CPU samples${
    options.nativeFrequencyHz ? ` at ${options.nativeFrequencyHz} Hz` : ''
  })`;
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const frames = [...sample.frames]
      .reverse()
      .map((frame) =>
        sample.hermes
          ? clean(frame.name)
          : `${clean(frame.name)} [${libraryName(frame.file)}]`
      );
    const key = [
      sample.hermes ? 'JS (Hermes wall-clock samples)' : native,
      thread(sample),
      ...frames,
    ].join(';');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([stack, count]) => `${stack} ${count}`)
      .join('\n') + '\n'
  );
}
