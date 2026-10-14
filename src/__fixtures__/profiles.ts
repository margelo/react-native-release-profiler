import { SourceMapGenerator } from 'source-map';

/** Composed Hermes map of a release build whose functions start at bytecode 100 and 300. */
export function releaseMap(offsets: number[] = [0, 100, 300]): string {
  const generator = new SourceMapGenerator();
  for (const [column, line] of [
    [100, 10],
    [300, 20],
  ] as const)
    generator.addMapping({
      generated: { line: 1, column },
      original: { line, column: 0 },
      source: 'src/app.ts',
    });
  return JSON.stringify({
    ...generator.toJSON(),
    x_hermes_function_offsets: { 0: offsets },
  });
}

/** Metro dev-server map: source positions, no Hermes function offsets. */
export function devServerMap(): string {
  const generator = new SourceMapGenerator();
  generator.addMapping({
    generated: { line: 50, column: 0 },
    original: { line: 10, column: 0 },
    source: 'src/app.ts',
  });
  return JSON.stringify(generator.toJSON());
}

const traceEvents = [
  {
    name: 'process_name',
    ph: 'M',
    cat: '__metadata',
    pid: 4242,
    ts: '1000',
    tid: '-1',
    args: { name: 'hermes' },
  },
  {
    name: 'thread_name',
    ph: 'M',
    cat: '__metadata',
    pid: 4242,
    ts: '1000',
    tid: '7',
    args: { name: 'mqt_v_js' },
  },
];

const samples = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    cpu: '-1',
    name: '',
    ts: String(1000 + i * 10000),
    pid: 4242,
    tid: '7',
    weight: '1',
    sf: i % 2 ? 3 : 2,
  }));

/** Release (bytecode) profile sampling the functions of `releaseMap()`. */
export function releaseProfile(sampleCount = 10): string {
  return JSON.stringify({
    traceEvents,
    samples: samples(sampleCount),
    stackFrames: {
      1: { name: '[root]', category: 'root' },
      2: {
        name: 'parseCatalog',
        category: 'JavaScript',
        funcVirtAddr: '100',
        offset: '5',
        parent: 1,
      },
      3: {
        name: 'sortInventory',
        category: 'JavaScript',
        funcVirtAddr: '300',
        offset: '2',
        parent: 2,
      },
    },
  });
}

/** Debug (dev server) profile: source positions instead of bytecode addresses. */
export function debugProfile(): string {
  return JSON.stringify({
    traceEvents,
    samples: samples(10),
    stackFrames: {
      1: { name: '[root]', category: 'root' },
      2: {
        name: 'parseCatalog(http://localhost:8081/index.bundle?platform=android&dev=true&minify=false:50:5)',
        category: 'JavaScript',
        line: '50',
        column: '5',
        funcLine: '50',
        funcColumn: '1',
        parent: 1,
      },
      3: {
        name: 'sortInventory(http://localhost:8081/index.bundle?platform=android&dev=true&minify=false:50:9)',
        category: 'JavaScript',
        line: '50',
        column: '9',
        funcLine: '50',
        funcColumn: '8',
        parent: 2,
      },
    },
  });
}
