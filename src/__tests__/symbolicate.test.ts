import fs from 'fs';
import os from 'os';
import path from 'path';
import { SourceMapGenerator } from 'source-map';
import type { HermesProfile } from '../mergeProfiles';
import {
  assertSourceMapMatchesProfile,
  decodeFunctionMap,
  hasRewrittenFrames,
  MIN_FUNCTION_MATCH,
  parseSourceMap,
  readHermesProfile,
  sourceMapMatch,
  sourceMapMatchAccepted,
  symbolicateFrames,
} from '../symbolicate';
import { isBytecodeProfile } from '../sourcemapUtils';

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
  add(306, 60, 4, 'JSON'); // parseCatalog's statement, inlined into the callback by Hermes
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
      4: { name: '', category: 'JavaScript', funcVirtAddr: '300', offset: '6' },
    },
  } as unknown as HermesProfile;

  it("uses Hermes' function name, not the source-map token at the sampled offset", async () => {
    const { frames } = await symbolicateFrames(profile, JSON.stringify(map));
    expect(frames.get('1')).toMatchObject({
      function: 'parseCatalog',
      name: 'parseCatalog (src/profilerWorkloads.ts:60:5)',
      line: 60,
      functionLine: 52,
      functionColumn: 8,
    });
  });

  it('names anonymous functions from the Metro function map', async () => {
    const { frames } = await symbolicateFrames(profile, JSON.stringify(map));
    expect(frames.get('2')!.function).toBe('useLayoutEffect$argument_0');
    expect(frames.get('3')!.function).toBe('useLayoutEffect$argument_0');
  });

  it('names an anonymous function after itself when it samples inlined code', async () => {
    const { frames } = await symbolicateFrames(profile, JSON.stringify(map));
    expect(frames.get('4')).toMatchObject({
      function: 'useLayoutEffect$argument_0',
      line: 60,
      functionLine: 291,
    });
  });

  it('keeps the Hermes name when the map has no function map', async () => {
    const plain: Record<string, unknown> = { ...map };
    delete plain.x_facebook_sources;
    const { frames } = await symbolicateFrames(profile, JSON.stringify(plain));
    expect(frames.get('1')!.function).toBe('parseCatalog');
    expect(frames.get('2')!.function).toBe('(anonymous)');
  });
});

// A composed Hermes map: the global function at 0, app functions from 10000 on (Hermes'
// internal bytecode reports addresses such as 1288 below that). Every generated column maps
// to src/app.ts line (column / 100 + 1), so locations are predictable.
const appMap = (offsets = [0, 10000, 20000, 30000, 40000, 50000]) => {
  const generator = new SourceMapGenerator();
  for (let column = 0; column <= 60000; column += 100)
    generator.addMapping({
      generated: { line: 1, column },
      original: { line: column / 100 + 1, column: 0 },
      source: 'src/app.ts',
    });
  return {
    ...JSON.parse(generator.toString()),
    x_hermes_function_offsets: { 0: offsets },
  };
};
const bytecode = (address: number, offset = 0, name = `f${address}`) => ({
  name,
  category: 'JavaScript',
  funcVirtAddr: String(address),
  offset: String(offset),
});
const profileOf = (...frames: object[]) =>
  ({
    samples: [],
    stackFrames: Object.fromEntries(
      frames.map((frame, index) => [String(index + 1), frame])
    ),
  } as unknown as HermesProfile);
const sourceFrame = (line: number) => ({
  name: `f(http://localhost:8081/index.bundle?platform=android:${line}:3)`,
  category: 'JavaScript',
  line: String(line),
  column: '3',
  funcLine: String(line),
  funcColumn: '1',
});

describe('source map acceptance', () => {
  const map = appMap();

  it('accepts 4 of 5 sampled functions (80%) and rejects 3 of 5', () => {
    expect(
      sourceMapMatchAccepted(
        sourceMapMatch(
          map,
          profileOf(
            ...[10000, 20000, 30000, 40000, 41000].map((a) => bytecode(a))
          )
        )
      )
    ).toBe(true);
    expect(() =>
      assertSourceMapMatchesProfile(
        map,
        profileOf(
          ...[10000, 20000, 30000, 40000, 41000].map((a) => bytecode(a))
        )
      )
    ).not.toThrow();
    expect(() =>
      assertSourceMapMatchesProfile(
        map,
        profileOf(
          ...[10000, 20000, 30000, 41000, 42000].map((a) => bytecode(a))
        )
      )
    ).toThrow('only 3 of 5 sampled Hermes functions');
  });

  it('pins the threshold at 80%', () => {
    expect(MIN_FUNCTION_MATCH).toBe(0.8);
    expect(sourceMapMatchAccepted({ checked: 10, matched: 8 })).toBe(true);
    expect(sourceMapMatchAccepted({ checked: 10, matched: 7 })).toBe(false);
    expect(sourceMapMatchAccepted({ checked: 0, matched: 0 })).toBe(true);
  });

  // RN 0.88 short capture: Hermes' internal Promise functions report addresses between the
  // app's functions (27776 > the first app function), not below them.
  const internalPromise = [
    bytecode(17000, 8, 'tryCallOne'),
    bytecode(17030, 12, 'tryCallTwo'),
    bytecode(17064, 40, 'Promise'),
    bytecode(27137, 62, ''),
  ];

  it('does not count Hermes-internal or unnamed unlisted functions against the map', () => {
    const profile = profileOf(
      ...[10000, 20000, 30000].map((a) => bytecode(a)),
      ...internalPromise
    );
    expect(sourceMapMatch(map, profile)).toEqual({ checked: 3, matched: 3 });
    expect(() => assertSourceMapMatchesProfile(map, profile)).not.toThrow();
  });

  it('still rejects a map when named app functions are unlisted', () => {
    const profile = profileOf(
      bytecode(10000),
      bytecode(41000, 0, 'formatRow'),
      bytecode(42000, 0, 'parseCatalog'),
      ...internalPromise
    );
    expect(() => assertSourceMapMatchesProfile(map, profile)).toThrow(
      'only 1 of 3 sampled Hermes functions'
    );
  });

  it('labels named Hermes-internal frames as internal, not unmapped', async () => {
    const { frames, unmappedFrames } = await symbolicateFrames(
      profileOf(
        bytecode(10000),
        bytecode(20000),
        ...internalPromise.slice(0, 2)
      ),
      JSON.stringify(map)
    );
    expect(frames.get('3')!.name).toBe('tryCallOne [Hermes internal]');
    expect(frames.get('4')!.name).toBe('tryCallTwo [Hermes internal]');
    expect(unmappedFrames).toBe(0);
  });

  it('rejects a real debug capture shape (58 source + 2 bytecode frames) as a debug build', () => {
    const frames = [
      ...Array.from({ length: 58 }, (_, i) => sourceFrame(100 + i)),
      bytecode(1288, 8, 'tryCallOne'),
      bytecode(4922, 62, ''),
    ];
    expect(() =>
      assertSourceMapMatchesProfile(map, profileOf(...frames))
    ).toThrow('debug build');
  });

  it('treats a majority (not half) of source frames as a debug build', () => {
    const bytecodeFrames = [10000, 20000].map((a) => bytecode(a));
    expect(() =>
      assertSourceMapMatchesProfile(
        map,
        profileOf(
          sourceFrame(1),
          sourceFrame(2),
          sourceFrame(3),
          ...bytecodeFrames
        )
      )
    ).toThrow('debug build');
    expect(() =>
      assertSourceMapMatchesProfile(
        map,
        profileOf(sourceFrame(1), sourceFrame(2), ...bytecodeFrames)
      )
    ).not.toThrow();
  });

  it('rejects a release profile with a map that has no Hermes function offsets', () => {
    const { x_hermes_function_offsets, ...packager } = map;
    expect(x_hermes_function_offsets).toBeDefined();
    expect(() =>
      assertSourceMapMatchesProfile(
        packager,
        profileOf(bytecode(10000), bytecode(20000))
      )
    ).toThrow(expect.objectContaining({ code: 'E_SOURCEMAP_UNRESOLVED' }));
  });

  it('handles maps listing hundreds of thousands of functions', () => {
    // Spreading >~120k offsets into Math.min overflowed the stack (RangeError).
    const offsets = Array.from({ length: 300000 }, (_, i) => i * 10);
    expect(
      sourceMapMatch(
        { x_hermes_function_offsets: { 0: offsets } },
        profileOf(bytecode(10), bytecode(2999990), bytecode(15))
      )
    ).toEqual({ checked: 3, matched: 2 });
  });
});

describe('legacy --raw profiles (bytecode rewritten to line 1 / column)', () => {
  // What `--raw` wrote: line '1', column funcVirtAddr + offset + 1, addresses deleted.
  const rewritten = (
    address: number,
    offset: number,
    name = `f${address}`
  ) => ({
    name,
    category: 'JavaScript',
    line: '1',
    column: String(address + offset + 1),
  });
  const original = profileOf(
    bytecode(20000, 250),
    bytecode(30000, 0),
    bytecode(1288, 8, 'tryCallOne')
  );
  const raw = profileOf(
    rewritten(20000, 250),
    rewritten(30000, 0),
    rewritten(1288, 8, 'tryCallOne')
  );

  it('is a release profile, not a debug build', () => {
    expect(() => assertSourceMapMatchesProfile(appMap(), raw)).not.toThrow();
    // The legacy converter must not fall back to the Metro dev server for it either.
    expect(isBytecodeProfile(raw)).toBe(true);
    expect(hasRewrittenFrames(raw)).toBe(true);
    expect(hasRewrittenFrames(original)).toBe(false);
  });

  it('symbolicates like the original profile, but reports the map as unverified', async () => {
    const map = JSON.stringify(appMap());
    const fromOriginal = await symbolicateFrames(original, map);
    const fromRaw = await symbolicateFrames(raw, map);
    // App frames resolve exactly as in the original (Hermes-internal frames have no
    // listed start to recover, so only their names are compared).
    expect(fromRaw.frames.get('1')).toEqual(fromOriginal.frames.get('1'));
    expect(fromRaw.frames.get('2')).toEqual(fromOriginal.frames.get('2'));
    expect(fromRaw.frames.get('1')).toMatchObject({
      name: 'f20000 (src/app.ts:203:1)',
      functionId: '1:20000',
      functionLine: 201,
    });
    expect(fromRaw.frames.get('2')!.entry).toBe(true);
    expect(fromRaw.frames.get('3')!.name).toBe('tryCallOne [Hermes internal]');
    expect(fromOriginal.unverifiedFrames).toBe(0);
    expect(fromRaw.unverifiedFrames).toBe(2);
  });
});

describe('frames the app map cannot describe', () => {
  it("keeps Hermes' internal bytecode (below the first app function) out of the app map", async () => {
    const { frames, symbolicatedFrames, unmappedFrames } =
      await symbolicateFrames(
        profileOf(
          bytecode(1288, 8, 'tryCallOne'),
          bytecode(4922 - 40000, 62, ''),
          bytecode(10000, 10, 'app')
        ),
        JSON.stringify(appMap([0, 10000, 20000]))
      );
    expect(frames.get('1')).toMatchObject({
      name: 'tryCallOne [Hermes internal]',
      function: 'tryCallOne',
      hermesInternal: true,
    });
    expect(frames.get('1')!.source).toBeUndefined();
    expect(frames.get('2')!.name).toBe('(anonymous) [Hermes internal]');
    expect(frames.get('3')!.name).toBe('app (src/app.ts:101:1)');
    expect(symbolicatedFrames).toBe(1);
    expect(unmappedFrames).toBe(0);
  });

  it('marks bytecode frames of a debug profile as Hermes internal', async () => {
    const generator = new SourceMapGenerator();
    generator.addMapping({
      generated: { line: 100, column: 2 },
      original: { line: 7, column: 0 },
      source: 'src/app.ts',
    });
    const { frames, unmappedFrames } = await symbolicateFrames(
      profileOf(
        sourceFrame(100),
        sourceFrame(100),
        bytecode(1288, 8, 'tryCallOne')
      ),
      generator.toString()
    );
    expect(frames.get('1')!.source).toBe('src/app.ts');
    expect(frames.get('3')!.name).toBe('tryCallOne [Hermes internal]');
    expect(unmappedFrames).toBe(0);
  });

  it('does not resolve functions whose start the map does not list (partly matching map)', async () => {
    // 4 of 5 functions match (accepted); 41000 is from another build: resolving it would
    // name whatever code the map has at that offset.
    const { frames, unmappedFrames } = await symbolicateFrames(
      profileOf(
        ...[10000, 20000, 30000, 40000, 41000].map((a) => bytecode(a, 20))
      ),
      JSON.stringify(appMap())
    );
    expect(frames.get('4')!.name).toBe('f40000 (src/app.ts:401:1)');
    expect(frames.get('5')!.name).toBe('f41000 [unmapped JS]');
    expect(frames.get('5')!.source).toBeUndefined();
    expect(unmappedFrames).toBe(1);
  });

  it('does not blame the map when there were no app frames to resolve', async () => {
    const { symbolicatedFrames } = await symbolicateFrames(
      profileOf(bytecode(1288, 8, 'tryCallOne'), {
        name: '[root]',
        category: 'root',
      }),
      JSON.stringify(appMap())
    );
    expect(symbolicatedFrames).toBe(0);
    await expect(
      symbolicateFrames(
        profileOf(bytecode(10000, 1)),
        JSON.stringify(appMap([0, 10000, 90000])).replace(
          /"mappings":"[^"]*"/,
          '"mappings":""'
        )
      )
    ).rejects.toMatchObject({ code: 'E_SOURCEMAP_UNRESOLVED' });
  });
});

describe('invalid inputs', () => {
  it('fails with E_USAGE when --sourcemap-path is not a source map', async () => {
    const profile = profileOf(bytecode(10000));
    for (const text of [
      'not json',
      '{"traceEvents":[],"samples":[]}',
      'null',
      // The source-map library rejects it (unsupported version).
      '{"version":2,"mappings":"","sources":[],"x_hermes_function_offsets":{"0":[0,10000]}}',
    ])
      await expect(symbolicateFrames(profile, text)).rejects.toMatchObject({
        code: 'E_USAGE',
      });
    expect(() => parseSourceMap('[1,2]')).toThrow('not a source map');
  });

  it('reads Hermes profiles with E_HERMES_PROFILE for missing or corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-hermes-'));
    const write = (name: string, content: string) => {
      fs.writeFileSync(path.join(dir, name), content);
      return path.join(dir, name);
    };
    const good = {
      stackFrames: { 1: { name: 'f', category: 'JavaScript' } },
      samples: [{ ts: '100', pid: 1, tid: '2', sf: 1 }],
    };
    expect(readHermesProfile(write('good', JSON.stringify(good)))).toEqual(
      good
    );
    for (const file of [
      path.join(dir, 'missing'),
      dir,
      write('truncated', JSON.stringify(good).slice(0, 30)),
      write('null', 'null'),
      write(
        'samples-object',
        JSON.stringify({ ...good, samples: { length: 1 } })
      ),
      write('no-frames', JSON.stringify({ ...good, stackFrames: {} })),
      write(
        'float-ts',
        JSON.stringify({
          ...good,
          samples: [{ ...good.samples[0], ts: '1.5' }],
        })
      ),
      write(
        'no-ts',
        JSON.stringify({ ...good, samples: [{ pid: 1, tid: '2', sf: 1 }] })
      ),
    ])
      expect(() => readHermesProfile(file)).toThrow(
        expect.objectContaining({ code: 'E_HERMES_PROFILE' })
      );
  });
});
