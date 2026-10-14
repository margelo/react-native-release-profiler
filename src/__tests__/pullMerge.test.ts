import fs from 'fs';
import path from 'path';
import {
  fakeAdb,
  removeTempDirs,
  tempDir,
  type FakeDevice,
} from '../__fixtures__/fakeAdb';
import { pullSession } from '../pullMerge';

const DIR = '/sdcard/Download/release-profiler';
const ID_OLD = '11111111-1111-4111-8111-111111111111';
const ID_NEW = '22222222-2222-4222-8222-222222222222';
const manifest = (packageName: string) =>
  JSON.stringify({ version: 1, sessionId: 'x', packageName });

let restore: () => void;
afterEach(() => {
  restore?.();
  removeTempDirs();
});
jest.spyOn(console, 'log').mockImplementation(() => {});

function device(state: FakeDevice = {}) {
  const adb = fakeAdb(state);
  restore = adb.use();
  return adb;
}
const directory = () => tempDir('rp-pull-');
const error = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('expected an error');
};

describe('pullSession', () => {
  it('reports adb failures while filtering by --appId as E_ADB, not E_NO_SESSIONS', () => {
    const adb = device({ fail: 'cat' });
    adb.file(`${DIR}/${ID_OLD}/session.json`, manifest('com.app'));
    const e = error(() =>
      pullSession({ appId: 'com.app', directory: directory() })
    );
    expect(e.code).toBe('E_ADB');
    expect(e.message).toContain('error: closed');
  });

  it('does not silently skip an unreadable newer manifest with --appId', () => {
    const adb = device();
    adb.file(`${DIR}/${ID_OLD}/session.json`, manifest('com.app'), 1000);
    adb.file(`${DIR}/${ID_NEW}/session.json`, '{"version": 1, "sess', 2000);
    const e = error(() =>
      pullSession({ appId: 'com.app', directory: directory() })
    );
    expect(e.code).toBe('E_SESSION_MANIFEST');
    expect(e.message).toContain(ID_NEW);
  });

  it('still skips sessions of other apps', () => {
    const adb = device();
    adb.file(`${DIR}/${ID_OLD}/session.json`, manifest('com.app'), 1000);
    adb.file(`${DIR}/${ID_NEW}/session.json`, manifest('com.other'), 2000);
    expect(
      pullSession({ appId: 'com.app', directory: directory() }).sessionId
    ).toBe(ID_OLD);
  });

  it('skips exports a force-stop left incomplete (.pending files)', () => {
    const adb = device();
    adb.file(`${DIR}/${ID_OLD}/session.json`, manifest('com.app'), 1000);
    adb.file(`${DIR}/${ID_NEW}/session.json`, manifest('com.app'), 2000);
    adb.file(`${DIR}/${ID_NEW}/.pending-1792586684-hermes.cpuprofile`, '');
    expect(pullSession({ directory: directory() }).sessionId).toBe(ID_OLD);
  });

  it('explains an incomplete export requested by ID', () => {
    const adb = device();
    adb.file(`${DIR}/${ID_NEW}/hermes.cpuprofile`, '{}');
    adb.file(`${DIR}/${ID_NEW}/.pending-1792586687-session.json`, '');
    const e = error(() =>
      pullSession({ sessionId: ID_NEW, directory: directory() })
    );
    expect(e.code).toBe('E_SESSION_MANIFEST');
    expect(e.message).toContain('not exported completely');
  });

  it('reports a session ID that is not on the device', () => {
    device();
    const e = error(() =>
      pullSession({ sessionId: ID_NEW, directory: directory() })
    );
    expect(e.code).toBe('E_NO_SESSIONS');
  });

  it('points API < 35 devices to the legacy flow', () => {
    device({ api: 34 });
    const e = error(() =>
      pullSession({ appId: 'com.app', directory: directory() })
    );
    expect(e.code).toBe('E_NO_SESSIONS');
    expect(e.message).toContain('Android 15');
    expect(e.message).toContain('--fromDownload --appId com.app');
    expect(e.message).not.toContain('session.stop(true)');
  });

  it('tells the user to pass --device when several devices are connected', () => {
    device({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'SER2', state: 'device' },
      ],
    });
    const e = error(() => pullSession({ directory: directory() }));
    expect(e.code).toBe('E_ADB');
    expect(e.message).toContain('pass --device <serial>');
  });

  it('pulls the latest session on the requested device', () => {
    const adb = device({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'SER2', state: 'device' },
      ],
    });
    adb.file(`${DIR}/${ID_OLD}/session.json`, manifest('com.app'));
    const pulled = pullSession({ device: 'SER2', directory: directory() });
    expect(
      fs.readFileSync(path.join(pulled.directory, 'session.json'), 'utf8')
    ).toBe(manifest('com.app'));
    expect(adb.calls().every((call) => call[1] === 'SER2')).toBe(true);
  });
});
