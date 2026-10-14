import fs from 'fs';
import path from 'path';
import { fakeAdb, removeTempDirs, tempDir } from '../__fixtures__/fakeAdb';
import { releaseMap, releaseProfile } from '../__fixtures__/profiles';

// The CLI must work when the optional @react-native-community/cli-tools peer is missing.
jest.mock(
  '@react-native-community/cli-tools',
  () => {
    throw new Error("Cannot find module '@react-native-community/cli-tools'");
  },
  { virtual: true }
);

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  removeTempDirs();
});

/** Run the CLI in-process; returns stdout and the exit code it set. */
async function cli(...args: string[]) {
  const argv = process.argv;
  process.argv = ['node', 'cli.js', ...args];
  let stdout = '';
  const write = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: any) => {
      stdout += String(chunk);
      return true;
    });
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    let completed: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      completed = require('../cli').completed;
    });
    await completed;
  } finally {
    write.mockRestore();
    log.mockRestore();
    process.argv = argv;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { stdout, exitCode };
}
const json = (stdout: string) => {
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
};

describe('cli --json', () => {
  it.each([[['--help']], [['-h']], [['analyze', '--help']]])(
    'prints help %j as one JSON object',
    async (args) => {
      const { stdout, exitCode } = await cli(...args, '--json');
      const result = json(stdout);
      expect(result).toMatchObject({ ok: true, command: 'help' });
      expect(result.result.text).toContain('Usage:');
      expect(exitCode).toBe(0);
    }
  );

  it('reports failed doctor checks as ok:false with exit code 1', async () => {
    const adb = fakeAdb({ devices: [] });
    restore = adb.use();
    const { stdout, exitCode } = await cli('doctor', '--json');
    const result = json(stdout);
    expect(result).toMatchObject({
      ok: false,
      command: 'doctor',
      error: { code: 'E_DOCTOR_FAILED' },
    });
    expect(result.result.checks.length).toBeGreaterThan(1);
    expect(exitCode).toBe(1);
  });

  it('refuses pull-merge --merge-session instead of merging the device’s latest session', async () => {
    const adb = fakeAdb();
    restore = adb.use();
    const { stdout, exitCode } = await cli(
      'pull-merge',
      '--merge-session',
      'captures/x/session.json',
      '--sourcemap-path',
      'release.map',
      '--json'
    );
    expect(json(stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'E_USAGE',
        message: expect.stringContaining(
          '--merge-session <path/to/session.json>'
        ),
      },
    });
    expect(exitCode).toBe(1);
    expect(adb.calls()).toEqual([]);
  });

  it('prints one JSON object for the legacy --local flow', async () => {
    const dir = tempDir('rp-cli-');
    const profile = path.join(dir, 'trace.cpuprofile');
    const map = path.join(dir, 'release.map');
    fs.writeFileSync(profile, releaseProfile());
    fs.writeFileSync(map, releaseMap());
    const output = path.join(dir, 'converted.json');
    const { stdout, exitCode } = await cli(
      '--local',
      profile,
      '--sourcemap-path',
      map,
      '--output',
      output,
      '--json'
    );
    expect(json(stdout)).toMatchObject({
      ok: true,
      command: 'legacy',
      result: { output, source: 'local', sourceMap: map },
    });
    expect(fs.existsSync(output)).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('accepts --device for the legacy flow', async () => {
    const adb = fakeAdb({
      devices: [
        { serial: 'SER1', state: 'device' },
        { serial: 'SER2', state: 'device' },
      ],
    });
    restore = adb.use();
    const { stdout } = await cli(
      '--fromDownload',
      '--appId',
      'com.app',
      '--device',
      'SER2',
      '--json'
    );
    expect(json(stdout)).toMatchObject({
      ok: false,
      error: { code: 'E_NO_PROFILE' },
    });
    expect(adb.calls()[0]!.slice(0, 2)).toEqual(['-s', 'SER2']);
  });
});
