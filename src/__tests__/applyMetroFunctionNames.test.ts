import fs from 'fs';
import os from 'os';
import path from 'path';
import transformer from '@margelo/hermes-profile-transformer';
import { logger } from '@react-native-community/cli-tools';
import { applyMetroFunctionNames } from '../applyMetroFunctionNames';

type ProfileEvent = Awaited<ReturnType<typeof transformer>>[number];

let directory: string;
let sourceMapPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-function-names-'));
  sourceMapPath = path.join(directory, 'index.map');
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeMap(
  metadata: unknown = [{ names: ['a', '<global>', 'b'], mappings: 'AAA,cC,CC' }]
) {
  fs.writeFileSync(
    sourceMapPath,
    JSON.stringify({
      version: 3,
      sources: ['file.js'],
      names: [],
      mappings: 'AAAA',
      x_facebook_sources: [metadata],
    })
  );
}

function event(line: unknown = 1, column: unknown = 0): ProfileEvent {
  return {
    ph: 'B' as ProfileEvent['ph'],
    name: 'minified',
    ts: 123,
    cat: 'JavaScript',
    args: {
      url: 'file.js',
      line,
      column,
      name: 'minified',
      params: 'identifier',
      allocatedName: 'minified',
    },
  };
}

test('uses Metro specification boundaries and preserves unrelated event data', () => {
  writeMap();
  const events = [event(1, 0), event(1, 13), event(1, 14), event(1, 15)];
  const original = events.map((item) => ({ ...item, args: { ...item.args } }));
  applyMetroFunctionNames(events, sourceMapPath);
  expect(events.map((item) => item.name)).toEqual(['a', 'a', 'minified', 'b']);
  expect(events[0]).toEqual({
    ...original[0],
    name: 'a',
    args: { ...original[0]?.args, name: 'a', params: 'a' },
  });
  expect(events[2]).toEqual(original[2]);
});

test('handles explicit line deltas, column resets, and negative name deltas', () => {
  writeMap([{ names: ['outer', 'inner'], mappings: ';EAC,IC;;ADC' }]);
  const events = [
    event(1, 0),
    event(2, 1),
    event(2, 2),
    event(2, 6),
    event(3, 0),
    event(4, 20),
  ];
  applyMetroFunctionNames(events, sourceMapPath);
  expect(events.map((item) => item.name)).toEqual([
    'minified',
    'minified',
    'outer',
    'inner',
    'outer',
    'outer',
  ]);
});

test('synchronizes args even when the event already has the correct name', () => {
  writeMap();
  const item = event('1', 0);
  item.name = 'a';
  applyMetroFunctionNames([item], sourceMapPath);
  expect(item.args).toMatchObject({ name: 'a', params: 'a' });
});

test.each([null, undefined, NaN, Infinity, -1, 0.5, 'invalid'])(
  'skips invalid columns: %s',
  (column) => {
    writeMap();
    const item = event(1, 0);
    item.args!.column = column;
    applyMetroFunctionNames([item], sourceMapPath);
    expect(item.name).toBe('minified');
  }
);

test('leaves events without mapped positions or metadata unchanged', () => {
  writeMap();
  const events = [
    event(0),
    event(null),
    { ...event(), args: undefined },
    { ...event(), args: { url: 'native' } },
  ];
  applyMetroFunctionNames(events, sourceMapPath);
  expect(events.every((item) => item.name === 'minified')).toBe(true);
});

test.each([null, [], [null], [{ names: ['a'], mappings: '' }]])(
  'allows absent function metadata: %j',
  (metadata) => {
    writeMap(metadata);
    const item = event();
    applyMetroFunctionNames([item], sourceMapPath);
    expect(item.name).toBe('minified');
    expect(logger.warn).not.toHaveBeenCalled();
  }
);

test.each(['!', 'AAAg', 'A', 'AAAA', 'ACA', 'AAA,DA', 'AAA;AAD'])(
  'ignores malformed mappings and warns once: %s',
  (mappings) => {
    writeMap([{ names: ['a'], mappings }]);
    const events = [event(), event()];
    applyMetroFunctionNames(events, sourceMapPath);
    expect(events.map((item) => item.name)).toEqual(['minified', 'minified']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  }
);

test('skips malformed metadata for one source while processing valid sources', () => {
  fs.writeFileSync(
    sourceMapPath,
    JSON.stringify({
      sources: ['file.js', 'valid.js'],
      x_facebook_sources: [
        [{ names: null, mappings: 42 }],
        [{ names: ['valid'], mappings: 'AAA' }],
      ],
    })
  );
  const valid = event();
  valid.args!.url = 'valid.js';
  const invalid = event();
  applyMetroFunctionNames([invalid, valid], sourceMapPath);
  expect(invalid.name).toBe('minified');
  expect(valid.name).toBe('valid');
});

test.each(['null', '{}', '{"sources":[]}', 'invalid json'])(
  'handles unsupported or unreadable map content: %s',
  (content) => {
    fs.writeFileSync(sourceMapPath, content);
    const item = event();
    applyMetroFunctionNames([item], sourceMapPath);
    expect(item.name).toBe('minified');
  }
);

test('supports conversion without a source map', () => {
  const item = event();
  applyMetroFunctionNames([item]);
  expect(logger.warn).not.toHaveBeenCalled();
  applyMetroFunctionNames([item], sourceMapPath);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(item.name).toBe('minified');
});

test('restores names in actual transformer output for both begin and end events', async () => {
  writeMap();
  const profilePath = path.join(directory, 'sample.cpuprofile');
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      stackFrames: {
        1: { name: 'minified', line: '1', column: '0', category: 'JavaScript' },
      },
      samples: [
        { sf: 1, ts: '100', pid: 1, tid: '1' },
        { sf: 1, ts: '110', pid: 1, tid: '1' },
      ],
    })
  );
  const events = await transformer(profilePath, sourceMapPath, 'index.bundle');
  expect(events.map((item) => item.name)).toEqual(['minified', 'minified']);
  applyMetroFunctionNames(events, sourceMapPath);
  expect(events.map((item) => [item.ph, item.name, item.ts])).toEqual([
    ['B', 'a', 100],
    ['E', 'a', 110],
  ]);
});
