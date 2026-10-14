import fs from 'fs';
import path from 'path';
import {
  fakeAdb,
  removeTempDirs,
  tempDir,
  type FakeAdb,
  type FakeDevice,
} from '../__fixtures__/fakeAdb';
import {
  debugProfile,
  devServerMap,
  releaseMap,
  releaseProfile,
} from '../__fixtures__/profiles';
import { runDoctor, type DoctorCheck } from '../doctor';

const DIR = '/sdcard/Download/release-profiler';
const ID = '9f6bb056-172c-40d7-9538-aa7665f07ebe';
const APP = 'com.app';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  delete process.env.ANDROID_SERIAL;
  removeTempDirs();
});

function device(state: FakeDevice = {}): FakeAdb {
  const adb = fakeAdb({ packages: { [APP]: {} }, ...state });
  restore = adb.use();
  return adb;
}

function session(
  adb: FakeAdb,
  profile: string | null,
  options: { id?: string; packageName?: string; mtime?: number } = {}
) {
  const id = options.id ?? ID;
  adb.file(
    `${DIR}/${id}/session.json`,
    JSON.stringify({
      version: 1,
      sessionId: id,
      packageName: options.packageName ?? APP,
      hermesProfilePath: 'hermes.cpuprofile',
      nativeStatus: 'success',
    }),
    options.mtime
  );
  if (profile !== null)
    adb.file(`${DIR}/${id}/hermes.cpuprofile`, profile, options.mtime);
}

function mapFile(content: string) {
  const file = path.join(tempDir('rp-doctor-'), 'index.android.bundle.map');
  fs.writeFileSync(file, content);
  return file;
}

const find = (checks: DoctorCheck[], name: string) =>
  checks.filter((check) => check.check === name).pop();
/** Device-local "YYYY-MM-DD HH:MM:SS", as `dumpsys package` prints it. */
const localTime = (seconds: number) => {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

describe('doctor source map check', () => {
  it('verifies the map against a Hermes profile larger than 1 MiB', async () => {
    const adb = device();
    const profile = releaseProfile(20000);
    expect(profile.length).toBeGreaterThan(1024 * 1024);
    session(adb, profile);
    const checks = await runDoctor({
      appId: APP,
      sourceMap: mapFile(releaseMap()),
    });
    expect(find(checks, 'sourcemap')).toMatchObject({
      status: 'ok',
      detail: `matches session ${ID} (2/2 functions)`,
    });
  });

  it('does not blame the map when the session profile cannot be read', async () => {
    const adb = device();
    session(adb, null);
    const check = find(
      await runDoctor({ appId: APP, sourceMap: mapFile(releaseMap()) }),
      'sourcemap'
    )!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('could not read session');
    expect(check.fix).not.toContain('source map');
  });

  it('fails a release map for a debug-build session, like merge does', async () => {
    const adb = device();
    session(adb, debugProfile());
    const check = find(
      await runDoctor({ appId: APP, sourceMap: mapFile(releaseMap()) }),
      'sourcemap'
    )!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('E_SOURCEMAP_MISMATCH');
  });

  it('fails a dev-server map for a release session, like merge does', async () => {
    const adb = device();
    session(adb, releaseProfile());
    const check = find(
      await runDoctor({ appId: APP, sourceMap: mapFile(devServerMap()) }),
      'sourcemap'
    )!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('E_SOURCEMAP_UNRESOLVED');
  });

  it('accepts a dev-server map for a debug session, like merge does', async () => {
    const adb = device();
    session(adb, debugProfile());
    expect(
      find(
        await runDoctor({ appId: APP, sourceMap: mapFile(devServerMap()) }),
        'sourcemap'
      )!.status
    ).toBe('ok');
  });

  it('fails a map without Hermes offsets when there is no session to check', async () => {
    device();
    const check = find(
      await runDoctor({ appId: APP, sourceMap: mapFile(devServerMap()) }),
      'sourcemap'
    )!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('x_hermes_function_offsets');
  });

  it('fails a map from another build of the app', async () => {
    const adb = device();
    session(adb, releaseProfile());
    const check = find(
      await runDoctor({
        appId: APP,
        sourceMap: mapFile(releaseMap([0, 110, 310])),
      }),
      'sourcemap'
    )!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('E_SOURCEMAP_MISMATCH');
  });

  it('only warns when the session predates the installed build', async () => {
    const recorded = Math.floor(Date.now() / 1000) - 3600;
    const adb = device({
      packages: { [APP]: { lastUpdateTime: localTime(recorded + 600) } },
    });
    session(adb, releaseProfile(), { mtime: recorded });
    const check = find(
      await runDoctor({
        appId: APP,
        sourceMap: mapFile(releaseMap([0, 110, 310])),
      }),
      'sourcemap'
    )!;
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('recorded before com.app was installed');
    expect(check.fix).toContain('Record a session with the installed build');
  });

  it('warns rather than fails for another app’s session without --appId', async () => {
    const adb = device();
    session(adb, releaseProfile(), { packageName: 'com.other' });
    const check = find(
      await runDoctor({ sourceMap: mapFile(releaseMap([0, 110, 310])) }),
      'sourcemap'
    )!;
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('--appId');
  });
});

describe('doctor device checks', () => {
  it('reports an unknown --device serial as a failing check', async () => {
    device();
    const checks = await runDoctor({ device: 'XYZ' });
    expect(find(checks, 'node')!.status).toBe('ok');
    expect(find(checks, 'device')).toMatchObject({ status: 'fail' });
    expect(find(checks, 'device')!.detail).toContain('XYZ is not connected');
  });

  it('honours ANDROID_SERIAL with several devices', async () => {
    const adb = device({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'SER2', state: 'device' },
      ],
    });
    process.env.ANDROID_SERIAL = 'SER2';
    const checks = await runDoctor({});
    expect(find(checks, 'device')).toMatchObject({
      status: 'ok',
      detail: 'SER2 (from ANDROID_SERIAL)',
    });
    expect(find(checks, 'android-api')!.status).toBe('ok');
    expect(
      adb
        .calls()
        .filter((call) => call[0] === '-s')
        .every((call) => call[1] === 'SER2')
    ).toBe(true);
  });

  it('fails with several transports even if only one is authorized', async () => {
    device({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'SER2', state: 'unauthorized' },
      ],
    });
    const check = find(await runDoctor({}), 'device')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('SER2 (unauthorized)');
    expect(check.fix).toContain('--device');
  });

  it('reports an unauthorized --device as a failing check', async () => {
    device({ devices: [{ serial: 'SER1', state: 'unauthorized' }] });
    expect(find(await runDoctor({ device: 'SER1' }), 'device')).toMatchObject({
      status: 'fail',
      detail: 'SER1 is unauthorized',
    });
  });

  it('keeps earlier checks when adb fails mid-run', async () => {
    device({ fail: 'ls' });
    const checks = await runDoctor({ appId: APP });
    expect(checks.map((check) => [check.check, check.status])).toEqual([
      ['node', 'ok'],
      ['device', 'ok'],
      ['android-api', 'ok'],
      ['rate-limiter', 'warn'],
      ['app', 'ok'],
      ['device', 'fail'],
    ]);
    expect(find(checks, 'device')!.detail).toContain('error: closed');
  });

  it.each(['version', 'devices', 'getprop'])(
    'does not hang when adb %s hangs',
    async (step) => {
      device({ hang: step });
      const checks = await runDoctor({ adbTimeoutMs: 500 });
      expect(checks.some((check) => check.status === 'fail')).toBe(true);
      expect(checks.map((check) => check.detail).join(' ')).toContain(
        'timed out'
      );
    }
  );

  it('points API 34 devices to the legacy flow', async () => {
    device({ api: 34 });
    const checks = await runDoctor({ appId: APP });
    expect(find(checks, 'sessions')!.fix).toContain(
      '--fromDownload --appId com.app'
    );
    expect(find(checks, 'android-api')!.fix).toContain('stopProfiling(true)');
  });

  it('skips and reports exports a force-stop left incomplete', async () => {
    const adb = device();
    session(adb, releaseProfile());
    adb.file(
      `${DIR}/22222222-2222-4222-8222-222222222222/.pending-1792586687-session.json`,
      ''
    );
    const check = find(await runDoctor({ appId: APP }), 'sessions')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toContain(`latest ${ID}`);
    expect(check.detail).toContain('skipped 1 incomplete export');
  });
});
