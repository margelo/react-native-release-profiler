import { SourceMapGenerator } from 'source-map';
import type { HermesProfile } from '../mergeProfiles';
import { decodeFunctionMap, symbolicateFrames } from '../symbolicate';

// Metro function map of a real profilerWorkloads.ts (RN 0.87 consumer app).
const functionMap = {
  names: [
    '<global>',
    'clock',
    'makeCatalogPayload',
    'parseCatalog',
    'compareInventory',
    'sortInventory',
    'computePrimes',
    '<anonymous>',
    'padCell',
    'formatRow',
    'formatReportTotals',
    'buildReport',
    'renderHeavyList',
    'useLayoutEffect$argument_0',
    'sleep',
    'Promise$argument_0',
    'runSchedule',
    'measure$argument_1',
  ],
  mappings:
    'AAA;cCY,gBD;AEmB;CFe;OGK;CHmB;OIU;CJW;OKE;CLmB;OMM;CN0B;kCOmB;CPc;AQE;CRM;OSE;CTgD;AUE;CVmB;OWE;CXa;OYc;kBCK;WNE,mBM;GDC;CZc;OciD;qBCC,oCD;CdC;OgBM;oBCW,2BD;ChBO',
};

describe('decodeFunctionMap', () => {
  it('decodes function start positions', () => {
    const ranges = decodeFunctionMap(functionMap);
    const at = (name: string) => ranges.find((r) => r.name === name);
    expect(at('parseCatalog')).toEqual({
      line: 52,
      column: 7,
      name: 'parseCatalog',
    });
    expect(at('buildReport')).toEqual({
      line: 259,
      column: 7,
      name: 'buildReport',
    });
    expect(at('useLayoutEffect$argument_0')).toEqual({
      line: 291,
      column: 18,
      name: 'useLayoutEffect$argument_0',
    });
  });
});

describe('symbolicateFrames naming', () => {
  // Bytecode addresses: parseCatalog starts at 100, an anonymous effect callback at 300.
  const generator = new SourceMapGenerator();
  const add = (column: number, line: number, col: number, name?: string) =>
    generator.addMapping({
      generated: { line: 1, column },
      original: { line, column: col },
      source: 'src/profilerWorkloads.ts',
      name,
    });
  add(100, 52, 7, 'parseCatalog');
  add(105, 60, 4, 'JSON'); // sampled statement: the token is `JSON`, not the function
  add(300, 291, 18);
  add(304, 292, 6, 'onCommitted');
  const map = {
    ...JSON.parse(generator.toString()),
    x_facebook_sources: [[functionMap]],
    x_hermes_function_offsets: { 0: [0, 100, 300] },
  };
  const profile = {
    samples: [],
    stackFrames: {
      1: {
        name: 'parseCatalog',
        category: 'JavaScript',
        funcVirtAddr: '100',
        offset: '5',
      },
      2: { name: '', category: 'JavaScript', funcVirtAddr: '300', offset: '4' },
      3: {
        name: '?anon_0_',
        category: 'JavaScript',
        funcVirtAddr: '300',
        offset: '4',
      },
    },
  } as unknown as HermesProfile;

  it("uses Hermes' function name, not the source-map token at the sampled offset", async () => {
    const { frames } = await symbolicateFrames(profile, JSON.stringify(map));
    expect(frames.get('1')).toMatchObject({
      function: 'parseCatalog',
      name: 'parseCatalog (src/profilerWorkloads.ts:60:5)',
      line: 60,
      functionLine: 52,
    });
  });

  it('names anonymous functions from the Metro function map', async () => {
    const { frames } = await symbolicateFrames(profile, JSON.stringify(map));
    expect(frames.get('2')!.function).toBe('useLayoutEffect$argument_0');
    expect(frames.get('3')!.function).toBe('useLayoutEffect$argument_0');
  });

  it('keeps the Hermes name when the map has no function map', async () => {
    const plain: Record<string, unknown> = { ...map };
    delete plain.x_facebook_sources;
    const { frames } = await symbolicateFrames(profile, JSON.stringify(plain));
    expect(frames.get('1')!.function).toBe('parseCatalog');
    expect(frames.get('2')!.function).toBe('(anonymous)');
  });
});
