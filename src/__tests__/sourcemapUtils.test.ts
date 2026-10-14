import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HermesProfile } from '../mergeProfiles';
import { findSourcemap, sourceMapFits } from '../sourcemapUtils';

const releaseProfile = {
  samples: [],
  stackFrames: {
    1: {
      name: 'parseCatalog',
      category: 'JavaScript',
      funcVirtAddr: '400',
      offset: '8',
    },
    2: {
      name: 'sortInventory',
      category: 'JavaScript',
      funcVirtAddr: '520',
      offset: '0',
    },
  },
} as unknown as HermesProfile;
const map = (offsets?: number[]) =>
  JSON.stringify({
    version: 3,
    sources: ['src/app.ts'],
    names: [],
    mappings: 'AAAA',
    ...(offsets ? { x_hermes_function_offsets: { 0: offsets } } : {}),
  });
const MATCHING = map([0, 100, 400, 520]);
const OTHER_BUILD = map([0, 100, 410, 530]);
const PACKAGER = map();

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-map-'));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, 'android/app/build', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}
const release = 'generated/sourcemaps/react/release/index.android.bundle.map';
const debug = 'generated/sourcemaps/react/debug/index.android.bundle.map';
const packager =
  'intermediates/sourcemaps/react/release/index.android.bundle.packager.map';
const options = { platform: 'android', dev: false, minify: true } as any;

describe('findSourcemap', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('prefers the composed release map when it matches the profile', async () => {
    const root = project({ [release]: MATCHING, [debug]: MATCHING });
    expect(await findSourcemap({ root }, '1', options, releaseProfile)).toBe(
      path.join(root, 'android/app/build', release)
    );
  });

  it('skips maps from another build', async () => {
    const root = project({ [release]: OTHER_BUILD, [debug]: MATCHING });
    expect(await findSourcemap({ root }, '1', options, releaseProfile)).toBe(
      path.join(root, 'android/app/build', debug)
    );
  });

  it('never falls back to the Metro dev server for a release profile', async () => {
    // Port 1 would fail; returning undefined proves no server was asked.
    const root = project({ [packager]: PACKAGER, [release]: OTHER_BUILD });
    expect(
      await findSourcemap({ root }, '1', options, releaseProfile)
    ).toBeUndefined();
  });
});

describe('sourceMapFits', () => {
  it('rejects maps without Hermes function offsets for release profiles', () => {
    const root = project({ [packager]: PACKAGER });
    expect(
      sourceMapFits(
        path.join(root, 'android/app/build', packager),
        releaseProfile
      )
    ).toMatchObject({ ok: false });
  });
});

describe('flattenSourceMap', () => {
  it('turns a sectioned (index) map into a flat map the transformer can read', async () => {
    const { flattenSourceMap } = require('../sourcemapUtils');
    const { SourceMapConsumer } = require('source-map');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-index-'));
    const file = path.join(root, 'index.map');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: {
              version: 3,
              sources: ['a.js'],
              names: ['f'],
              mappings: 'AAAAA',
            },
          },
          {
            offset: { line: 10, column: 0 },
            map: {
              version: 3,
              sources: ['assets/img.png', 'b.js'],
              names: [],
              mappings: 'ACAA',
            },
          },
        ],
      })
    );
    const flat = await flattenSourceMap(file);
    const raw = JSON.parse(fs.readFileSync(flat, 'utf8'));
    expect(raw.sections).toBeUndefined();
    const consumer = await new SourceMapConsumer(raw);
    expect(consumer.originalPositionFor({ line: 11, column: 0 })).toMatchObject(
      { source: 'b.js', line: 1 }
    );
    consumer.destroy();
  });
});
