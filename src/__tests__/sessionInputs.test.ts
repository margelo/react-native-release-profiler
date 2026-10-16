import fs from 'fs';
import os from 'os';
import path from 'path';
import { SourceMapGenerator } from 'source-map';
import { analyze } from '../analyze';
import { loadSession, mergeSession } from '../mergeProfiles';

// Missing or corrupt session artifacts must fail with the documented codes (re-pull /
// re-record), never with a raw ENOENT or JSON parser error (E_UNKNOWN).

const generator = new SourceMapGenerator();
generator.addMapping({
  generated: { line: 1, column: 10000 },
  original: { line: 3, column: 0 },
  source: 'src/app.ts',
});
const map = JSON.stringify({
  ...JSON.parse(generator.toString()),
  x_hermes_function_offsets: { 0: [0, 10000] },
});
const profile = {
  stackFrames: {
    1: {
      name: 'work',
      category: 'JavaScript',
      funcVirtAddr: '10000',
      offset: '4',
    },
  },
  samples: [
    { ts: '1000', pid: 1, tid: '2', sf: 1 },
    { ts: '2000', pid: 1, tid: '2', sf: 1 },
  ],
};
const manifest = {
  version: 1,
  sessionId: 's',
  pid: 1,
  hermesClock: 'monotonic',
  hermesProfilePath: '/sdcard/Download/release-profiler/s/hermes.cpuprofile',
  nativeProfilePath:
    '/sdcard/Download/release-profiler/s/native.perfetto-trace',
  nativeStatus: 'success',
  clockAnchors: [
    { monotonicNs: '1000000', boottimeNs: '5000000' },
    { monotonicNs: '3000000', boottimeNs: '7000000' },
  ],
};

function session(
  changes: {
    hermes?: string | null;
    native?: string | null;
    manifest?: string;
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-session-'));
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    changes.manifest ?? JSON.stringify(manifest)
  );
  const hermes = 'hermes' in changes ? changes.hermes : JSON.stringify(profile);
  if (hermes !== null)
    fs.writeFileSync(path.join(dir, 'hermes.cpuprofile'), hermes!);
  const native = 'native' in changes ? changes.native : 'not read';
  if (native !== null)
    fs.writeFileSync(path.join(dir, 'native.perfetto-trace'), native!);
  fs.writeFileSync(path.join(dir, 'release.map'), map);
  return {
    dir,
    manifest: path.join(dir, 'session.json'),
    sourceMap: path.join(dir, 'release.map'),
  };
}
const analyzeCode = (s: ReturnType<typeof session>) =>
  analyze({ session: s.dir, sourceMap: s.sourceMap }).then(
    () => 'ok',
    (error) => error.code ?? `E_UNKNOWN: ${error.message}`
  );
const mergeCode = (s: ReturnType<typeof session>) =>
  mergeSession({
    session: s.manifest,
    sourceMap: s.sourceMap,
    output: path.join(s.dir, 'out.trace'),
  }).then(
    () => 'ok',
    (error) => error.code ?? `E_UNKNOWN: ${error.message}`
  );

describe('corrupt or incomplete sessions', () => {
  it('a missing or truncated Hermes profile is E_HERMES_PROFILE', async () => {
    for (const hermes of [null, JSON.stringify(profile).slice(0, 40), 'null']) {
      expect(await analyzeCode(session({ hermes }))).toBe('E_HERMES_PROFILE');
      expect(await mergeCode(session({ hermes }))).toBe('E_HERMES_PROFILE');
    }
  });

  it('a missing native trace is E_TRACE_FORMAT', async () => {
    expect(await analyzeCode(session({ native: null }))).toBe('E_TRACE_FORMAT');
    expect(await mergeCode(session({ native: null }))).toBe('E_TRACE_FORMAT');
  });

  it('an unusable session.json is E_SESSION_MANIFEST', async () => {
    const badAnchor = JSON.stringify({
      ...manifest,
      clockAnchors: [{ monotonicNs: '1', boottimeNs: 'abc' }],
    });
    for (const text of ['null', '7', badAnchor]) {
      const s = session({ manifest: text });
      expect(() => loadSession(s.manifest)).toThrow(
        expect.objectContaining({ code: 'E_SESSION_MANIFEST' })
      );
      expect(await analyzeCode(s)).toBe('E_SESSION_MANIFEST');
    }
  });
});

describe('profiles pulled by the legacy --raw', () => {
  it('are analyzed as release profiles, with a warning that the map is unverified', async () => {
    const s = session();
    const raw = path.join(s.dir, 'raw.cpuprofile');
    fs.writeFileSync(
      raw,
      JSON.stringify({
        ...profile,
        stackFrames: {
          1: {
            name: 'work',
            category: 'JavaScript',
            line: '1',
            column: '10005',
          },
        },
      })
    );
    const report = await analyze({ profile: raw, sourceMap: s.sourceMap });
    expect(report.js.topFunctions[0]).toMatchObject({
      function: 'work',
      location: 'src/app.ts:3',
    });
    expect(report.quality.warnings).toContainEqual(
      expect.stringContaining('could not be verified')
    );
  });
});
