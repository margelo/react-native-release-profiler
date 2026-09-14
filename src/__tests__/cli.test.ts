import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import transformer from '@margelo/hermes-profile-transformer';
import { downloadProfile } from '../cli';
import { generateSourcemap, findSourcemap } from '../sourcemapUtils';

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
  execSync: jest.fn(),
}));
jest.mock('@react-native-community/cli-tools', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
  },
  CLIError: Error,
}));
jest.mock('@margelo/hermes-profile-transformer', () => jest.fn(async () => []));
jest.mock('../getConfig', () =>
  jest.fn(async () => ({
    root: '.',
    project: { android: { packageName: 'com.android.app' } },
  }))
);
jest.mock('../sourcemapUtils', () => ({
  generateSourcemap: jest.fn(async () => undefined),
  findSourcemap: jest.fn(async () => undefined),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() =>
  Object.defineProperty(process, 'platform', { value: 'darwin' })
);
afterAll(() => Object.defineProperty(process, 'platform', originalPlatform));

let destination: string;
const filename = 'profile with spaces.cpuprofile';
const profile = JSON.stringify({ stackFrames: {} });

beforeEach(() => {
  jest.clearAllMocks();
  destination = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-profile-test-'));
  (execFileSync as jest.Mock).mockImplementation((_command, args: string[]) => {
    fs.writeFileSync(args[args.indexOf('--destination') + 1]!, profile);
  });
});

afterEach(() => fs.rmSync(destination, { recursive: true, force: true }));

function download(
  overrides: {
    filename?: string;
    appId?: string;
    device?: string;
    raw?: boolean;
    platform?: string;
    fromDownload?: boolean;
    local?: string;
  } = {}
) {
  const options = {
    filename,
    appId: 'com.example.app',
    device: "Ilia's iPhone",
    raw: true,
    platform: 'ios',
    ...overrides,
  };
  return downloadProfile(
    options.local,
    options.fromDownload,
    destination,
    options.filename,
    undefined,
    options.raw,
    false,
    '8081',
    options.appId,
    undefined,
    options.platform,
    options.device
  );
}

test('copies an iOS trace from Library/Caches without invoking a shell or adb', async () => {
  await download();
  expect(execFileSync).toHaveBeenCalledWith(
    'xcrun',
    [
      'devicectl',
      'device',
      'copy',
      'from',
      '--device',
      "Ilia's iPhone",
      '--domain-type',
      'appDataContainer',
      '--domain-identifier',
      'com.example.app',
      '--source',
      `Library/Caches/${filename}`,
      '--destination',
      path.join(destination, filename),
    ],
    { stdio: 'inherit' }
  );
  expect(execSync).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(destination, filename), 'utf8')).toBe(
    profile
  );
});

test('converts the extracted trace and requests an iOS source map', async () => {
  await download({ raw: false });
  expect(transformer).toHaveBeenCalled();
  expect(generateSourcemap).toHaveBeenCalledWith(
    '8081',
    expect.objectContaining({ platform: 'ios' })
  );
  expect(findSourcemap).not.toHaveBeenCalled();
  expect(
    fs.readFileSync(
      path.join(destination, 'profile with spaces-converted.json'),
      'utf8'
    )
  ).toBe('[]');
  const args = (execFileSync as jest.Mock).mock.calls[0]![1] as string[];
  expect(fs.existsSync(args[args.indexOf('--destination') + 1]!)).toBe(false);
});

test.each([
  [{ device: undefined }, '--device'],
  [{ appId: undefined }, '--appId'],
  [{ filename: undefined }, '--filename'],
  [{ filename: '../profile.cpuprofile' }, '--filename'],
  [{ fromDownload: true }, '--fromDownload'],
  [{ platform: 'typo' }, '--platform'],
])('rejects invalid options %j before copying', async (options, message) => {
  await expect(download(options)).rejects.toThrow(message);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(execSync).not.toHaveBeenCalled();
});

test('propagates a failed device copy without attempting conversion', async () => {
  (execFileSync as jest.Mock).mockImplementation(() => {
    throw new Error('Device is locked');
  });
  await expect(download({ raw: false })).rejects.toThrow('Device is locked');
  expect(transformer).not.toHaveBeenCalled();
});

test('keeps local conversion available without iOS device arguments', async () => {
  const local = path.join(destination, filename);
  fs.writeFileSync(local, profile);
  await download({ local, raw: false, device: undefined, appId: undefined });
  expect(execFileSync).not.toHaveBeenCalled();
  expect(execSync).not.toHaveBeenCalled();
  expect(transformer).toHaveBeenCalled();
});

test('preserves Android raw download behavior by default', async () => {
  (execSync as jest.Mock).mockImplementation(() => {
    fs.writeFileSync(path.join(destination, 'profile.cpuprofile'), profile);
  });
  await downloadProfile(
    undefined,
    true,
    destination,
    'profile.cpuprofile',
    undefined,
    true,
    false,
    '8081',
    'com.example.app'
  );
  expect(execSync).toHaveBeenCalledWith(
    expect.stringContaining('adb shell cat /sdcard/Download/profile.cpuprofile')
  );
  expect(execFileSync).not.toHaveBeenCalled();
});

test('reports the macOS requirement before invoking device tools', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await expect(download()).rejects.toThrow('macOS');
    expect(execFileSync).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  }
});

test('uses an explicitly supplied source map for iOS conversion', async () => {
  await downloadProfile(
    undefined,
    false,
    destination,
    filename,
    '/maps/ios.map',
    false,
    false,
    '8081',
    'com.example.app',
    undefined,
    'ios',
    'device-id'
  );
  expect(transformer).toHaveBeenCalledWith(
    expect.any(String),
    '/maps/ios.map',
    'index.bundle'
  );
  expect(generateSourcemap).not.toHaveBeenCalled();
  expect(findSourcemap).not.toHaveBeenCalled();
});
