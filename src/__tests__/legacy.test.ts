import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  fakeAdb,
  removeTempDirs,
  tempDir,
  type FakeAdb,
  type FakeDevice,
} from '../__fixtures__/fakeAdb';
import { releaseMap, releaseProfile } from '../__fixtures__/profiles';
import {
  downloadProfile,
  pickDownloadProfile,
  profileBaseName,
  type LegacyOptions,
} from '../legacy';

const NOW = 1_800_000_000;
const APP = 'com.rpconsumer';
const MINE = 'sampling-profiler-trace111.cpuprofile.txt';
const OTHER = 'sampling-profiler-trace222.cpuprofile.txt';

let restore: (() => void) | undefined;
let tmp: string;
beforeEach(() => {
  tmp = tempDir('rp-legacy-');
  // Keep this test's temp files apart, to check that failures leave nothing behind.
  jest.spyOn(os, 'tmpdir').mockReturnValue(tmp);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  restore?.();
  restore = undefined;
  jest.restoreAllMocks();
  removeTempDirs();
});

function device(state: FakeDevice = {}): FakeAdb {
  const adb = fakeAdb({ now: NOW, packages: { [APP]: {} }, ...state });
  restore = adb.use();
  return adb;
}
const out = (name = '') => path.join(tmp, 'out', name);
const map = () => {
  const file = path.join(tmp, 'release.map');
  fs.writeFileSync(file, releaseMap());
  return file;
};
const run = (options: LegacyOptions) => {
  fs.mkdirSync(out(), { recursive: true });
  return downloadProfile({ sourcemapPath: map(), output: out(), ...options });
};
const leftovers = () =>
  fs.readdirSync(tmp).filter((name) => name.startsWith('rn-release-profiler-'));

describe('pickDownloadProfile', () => {
  const files = [
    { name: OTHER, mtime: NOW - 10, owner: 'com.rpconsumer.expo' },
    { name: MINE, mtime: NOW - 60, owner: APP },
    {
      name: 'sampling-profiler-trace0.cpuprofile.txt',
      mtime: NOW - 9000,
      owner: APP,
    },
  ];

  it("picks the app's newest profile, not another app's newer one", () => {
    expect(pickDownloadProfile(files, APP, NOW).name).toBe(MINE);
  });

  it('refuses profiles that only other apps saved', () => {
    expect(() => pickDownloadProfile(files, 'com.nothere', NOW)).toThrow(
      expect.objectContaining({ code: 'E_NO_PROFILE' })
    );
  });

  it('requires --filename when ownership is unknown and several files exist', () => {
    const unknown = files.map(({ name, mtime }) => ({ name, mtime }));
    expect(() => pickDownloadProfile(unknown, APP, NOW)).toThrow(
      expect.objectContaining({
        code: 'E_USAGE',
        message: expect.stringContaining('pass --filename'),
      })
    );
    expect(pickDownloadProfile(unknown.slice(0, 1), APP, NOW).name).toBe(OTHER);
  });

  it('requires --appId when several apps saved profiles and the app is unknown', () => {
    expect(() => pickDownloadProfile(files, undefined, NOW)).toThrow(
      expect.objectContaining({ message: expect.stringContaining('--appId') })
    );
  });
});

describe('profileBaseName', () => {
  it("drops Android's .txt and the .cpuprofile extension", () => {
    expect(profileBaseName('/sdcard/Download/x.cpuprofile.txt')).toBe('x');
    expect(profileBaseName('x.cpuprofile')).toBe('x');
    expect(profileBaseName('trace.json')).toBe('trace.json');
  });
});

describe('downloadProfile --fromDownload', () => {
  it("converts the app's own newest profile into --output", async () => {
    const adb = device({
      owners: { [MINE]: APP, [OTHER]: 'com.rpconsumer.expo' },
    });
    adb.file(`/sdcard/Download/${MINE}`, releaseProfile(), NOW - 120);
    adb.file(`/sdcard/Download/${OTHER}`, releaseProfile(), NOW - 10);
    const result = await run({ fromDownload: true, appId: APP });
    expect(result).toMatchObject({
      source: 'downloads',
      profile: `/sdcard/Download/${MINE}`,
      owner: APP,
      ageSeconds: 120,
      output: out('sampling-profiler-trace111-converted.json'),
      warnings: [],
    });
    const events = JSON.parse(fs.readFileSync(result.output, 'utf8'));
    expect(JSON.stringify(events)).toContain('src/app.ts');
    // Thread names survive the conversion (the transformer drops them).
    expect(events).toContainEqual({
      name: 'thread_name',
      ph: 'M',
      pid: 4242,
      tid: 7,
      args: { name: 'mqt_v_js' },
    });
    expect(leftovers()).toEqual([]);
  });

  it('finds the Downloads copy from the name stopProfiling() returned', async () => {
    const adb = device({ owners: { [MINE]: APP } });
    adb.file(`/sdcard/Download/${MINE}`, releaseProfile(), NOW - 5);
    const result = await run({
      fromDownload: true,
      appId: APP,
      filename: `/data/user/0/${APP}/cache/sampling-profiler-trace111.cpuprofile`,
      output: out('trace.json'),
    });
    expect(result.profile).toBe(`/sdcard/Download/${MINE}`);
    expect(result.output).toBe(out('trace.json'));
  });

  it('reports a missing --filename without leaving temp files', async () => {
    device();
    await expect(
      run({ fromDownload: true, appId: APP, filename: 'nope.cpuprofile' })
    ).rejects.toMatchObject({ code: 'E_NO_PROFILE' });
    expect(leftovers()).toEqual([]);
  });

  it('warns about old profiles', async () => {
    const adb = device({ owners: { [MINE]: APP } });
    adb.file(`/sdcard/Download/${MINE}`, releaseProfile(), NOW - 7200);
    const result = await run({ fromDownload: true, appId: APP });
    expect(result.warnings.join(' ')).toContain('saved 2 h ago');
  });

  it('pulls from the --device it is given', async () => {
    const adb = device({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'emulator-5554', state: 'device' },
      ],
      noMediaStore: true,
    });
    adb.file(`/sdcard/Download/${MINE}`, releaseProfile(), NOW - 5);
    const result = await run({
      fromDownload: true,
      appId: APP,
      device: 'emulator-5554',
    });
    expect(result.profile).toBe(`/sdcard/Download/${MINE}`);
    expect(result.warnings.join(' ')).toContain('Could not confirm');
    expect(adb.calls().every((call) => call[1] === 'emulator-5554')).toBe(true);
  });

  it('asks for --device instead of claiming there is no profile', async () => {
    device({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'emulator-5554', state: 'device' },
      ],
    });
    await expect(run({ fromDownload: true, appId: APP })).rejects.toMatchObject(
      {
        code: 'E_ADB',
        message: expect.stringContaining('pass --device <serial>'),
      }
    );
  });

  it('rejects an empty profile with E_HERMES_PROFILE', async () => {
    const adb = device({ owners: { [MINE]: APP } });
    adb.file(
      `/sdcard/Download/${MINE}`,
      JSON.stringify({ traceEvents: [], samples: [], stackFrames: {} }),
      NOW
    );
    await expect(run({ fromDownload: true, appId: APP })).rejects.toMatchObject(
      { code: 'E_HERMES_PROFILE' }
    );
  });
});

describe('downloadProfile from the app cache', () => {
  it('explains the Downloads route for release (non-debuggable) builds', async () => {
    device();
    await expect(run({ appId: APP })).rejects.toMatchObject({
      code: 'E_USAGE',
      message: expect.stringContaining(
        'stopProfiling(true) to also save the profile to Downloads, then run with --fromDownload'
      ),
    });
  });

  it('pulls the newest cached profile of a debuggable build', async () => {
    const adb = device({ packages: { [APP]: { debuggable: true } } });
    adb.file(
      `/data/${APP}/cache/sampling-profiler-trace9.cpuprofile`,
      releaseProfile()
    );
    const result = await run({ appId: APP, raw: true });
    expect(result).toMatchObject({
      source: 'cache',
      profile: 'cache/sampling-profiler-trace9.cpuprofile',
      output: out('sampling-profiler-trace9.cpuprofile'),
      sourceMap: null,
    });
  });
});
