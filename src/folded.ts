import type { StackSample } from './traceSamples';

const clean = (name: string) => name.replace(/;/g, ',').trim();
export const libraryName = (file: string) =>
  file.split('!').pop()!.split('/').pop()! || file;

/** Collapsed stacks (`track;root;…;leaf count`), the format flamegraph.pl and
 * speedscope read. Plain text, so agents can grep and diff it directly.
 */
export function toFolded(samples: StackSample[]): string {
  const jsThreads = new Set(samples.filter((s) => s.hermes).map((s) => s.tid));
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const track = sample.hermes
      ? `JS (Hermes) tid ${sample.tid}`
      : `native tid ${sample.tid}${
          jsThreads.has(sample.tid)
            ? ' (JS thread)'
            : sample.tid === sample.pid
            ? ' (main)'
            : ''
        }`;
    const frames = [...sample.frames]
      .reverse()
      .map((frame) =>
        sample.hermes
          ? clean(frame.name)
          : `${clean(frame.name)} [${libraryName(frame.file)}]`
      );
    const key = [track, ...frames].join(';');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([stack, count]) => `${stack} ${count}`)
      .join('\n') + '\n'
  );
}
