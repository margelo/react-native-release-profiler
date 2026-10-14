import { execFileSync } from 'child_process';
import fs from 'fs';
import { ProfilerError } from './errors';

/** Device output is read whole; profiles of long recordings exceed Node's 1 MiB default. */
export const MAX_BUFFER = 1024 * 1024 * 1024;

/** What the user can do about an adb failure, from adb's own message. */
export function adbHint(message: string): string | undefined {
  if (/more than one (device|emulator)/i.test(message))
    return 'Several devices are connected: pass --device <serial> (see `adb devices`) or set ANDROID_SERIAL';
  if (/device '.*' not found/i.test(message))
    return 'That device is not connected: pass a serial listed by `adb devices` to --device';
  if (/no devices|no emulators/i.test(message))
    return 'Connect a device with USB debugging enabled';
  if (/unauthorized/i.test(message))
    return 'Unlock the device and accept the USB debugging prompt';
  if (/offline/i.test(message))
    return 'Reconnect the device (or run `adb kill-server`)';
  return undefined;
}

export function adbFailure(args: string[], error: any): ProfilerError {
  if (error?.code === 'ENOENT')
    return new ProfilerError(
      'E_ADB',
      'adb is not on PATH; install Android platform-tools and add them to PATH'
    );
  if (error?.code === 'ETIMEDOUT')
    return new ProfilerError(
      'E_ADB',
      `adb ${args[0]} timed out; check the device connection (or run \`adb kill-server\`)`
    );
  const detail = String(error?.stderr || error?.message || error).trim();
  const hint = adbHint(detail);
  return new ProfilerError(
    'E_ADB',
    `adb ${args[0]} failed: ${detail}${hint ? `. ${hint}` : ''}`
  );
}

const withDevice = (device: string | undefined, args: string[]) => [
  ...(device ? ['-s', device] : []),
  ...args,
];

/** Run adb (on `device`, else adb's default: ANDROID_SERIAL or the only device). */
export function adb(
  device: string | undefined,
  args: string[],
  options: { timeout?: number } = {}
): string {
  try {
    return execFileSync('adb', withDevice(device, args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
      timeout: options.timeout,
      // Explicit, so the adb on this (possibly sandboxed, e.g. jest) process's PATH is used.
      env: process.env,
    });
  } catch (error) {
    throw adbFailure(args, error);
  }
}

/** Write a device command's stdout to `file` without buffering it in memory. */
export function adbToFile(
  device: string | undefined,
  args: string[],
  file: string
): void {
  const fd = fs.openSync(file, 'w');
  try {
    execFileSync('adb', withDevice(device, args), {
      stdio: ['ignore', fd, 'pipe'],
      maxBuffer: MAX_BUFFER,
      env: process.env,
    });
  } catch (error) {
    throw adbFailure(args, error);
  } finally {
    fs.closeSync(fd);
  }
}

/** Quote one argument for the device shell. */
export const shellQuote = (value: string) =>
  `'${value.replace(/'/g, `'\\''`)}'`;
