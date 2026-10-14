import { execFileSync } from 'child_process';
import fs from 'fs';
import type { HermesProfile, ProfileSessionManifest } from './mergeProfiles';
import { sourceMapMatch } from './symbolicate';

export interface DoctorCheck {
  check: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** Command or action that resolves a warn/fail. */
  fix?: string;
}

/** Environment checks for recording and merging, each with a concrete fix. */
export function runDoctor(options: {
  device?: string;
  appId?: string;
  sourceMap?: string;
}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const adb = (...args: string[]) =>
    execFileSync(
      'adb',
      [...(options.device ? ['-s', options.device] : []), ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }
    ).trim();

  const node = Number(process.versions.node.split('.')[0]);
  add(
    node >= 18
      ? { check: 'node', status: 'ok', detail: process.version }
      : {
          check: 'node',
          status: 'fail',
          detail: `${process.version} is too old`,
          fix: 'Use Node 18 or newer',
        }
  );

  try {
    execFileSync('adb', ['version'], { stdio: 'ignore' });
  } catch {
    add({
      check: 'adb',
      status: 'fail',
      detail: 'adb is not on PATH',
      fix: 'Install Android platform-tools and add them to PATH',
    });
    return checks;
  }
  const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map((parts) => parts[0]!);
  if (!devices.length) {
    add({
      check: 'device',
      status: 'fail',
      detail: 'No device connected (or not authorized)',
      fix: 'Connect a device with USB debugging enabled and accept the prompt',
    });
    return checks;
  }
  if (!options.device && devices.length > 1) {
    add({
      check: 'device',
      status: 'fail',
      detail: `${devices.length} devices connected: ${devices.join(', ')}`,
      fix: 'Pass --device <serial>',
    });
    return checks;
  }
  add({
    check: 'device',
    status: 'ok',
    detail: options.device ?? devices[0]!,
  });

  const api = Number(adb('shell', 'getprop', 'ro.build.version.sdk'));
  add(
    api >= 35
      ? { check: 'android-api', status: 'ok', detail: `API ${api}` }
      : {
          check: 'android-api',
          status: 'warn',
          detail: `API ${api}: native sampling needs Android 15 (API 35); only Hermes profiling works`,
          fix: 'Use an Android 15+ device or emulator',
        }
  );
  if (api >= 35) {
    const limiter = adb(
      'shell',
      'device_config',
      'get',
      'profiling_testing',
      'rate_limiter.disabled'
    );
    add(
      limiter === 'true'
        ? {
            check: 'rate-limiter',
            status: 'ok',
            detail: 'disabled for testing',
          }
        : {
            check: 'rate-limiter',
            status: 'warn',
            detail:
              'Android limits stack sampling (about one capture per app per hour); later captures fail with ERROR_FAILED_RATE_LIMIT_PROCESS',
            fix: 'adb shell device_config put profiling_testing rate_limiter.disabled true',
          }
    );
  }

  if (options.appId) {
    let installed = false;
    try {
      installed = adb('shell', 'pm', 'path', options.appId).startsWith(
        'package:'
      );
    } catch {}
    add(
      installed
        ? { check: 'app', status: 'ok', detail: `${options.appId} installed` }
        : {
            check: 'app',
            status: 'fail',
            detail: `${options.appId} is not installed`,
            fix: 'Install the release build you want to profile',
          }
    );
  }

  const listing = adb(
    'shell',
    'ls -1t /sdcard/Download/release-profiler/*/session.json 2>/dev/null || true'
  )
    .split(/\r?\n/)
    .filter((line) => line.endsWith('/session.json'));
  let latest: ProfileSessionManifest | undefined;
  let latestPath: string | undefined;
  for (const file of listing) {
    try {
      const manifest = JSON.parse(adb('shell', 'cat', file));
      if (options.appId && manifest.packageName !== options.appId) continue;
      latest = manifest;
      latestPath = file;
      break;
    } catch {}
  }
  if (!latest) {
    add({
      check: 'sessions',
      status: 'warn',
      detail: `No exported sessions${
        options.appId ? ` for ${options.appId}` : ''
      } in Download/release-profiler`,
      fix: 'Record with startProfilingSession() and finish with session.stop(true)',
    });
  } else {
    add({
      check: 'sessions',
      status: latest.nativeStatus === 'success' ? 'ok' : 'warn',
      detail: `${listing.length} exported; latest ${latest.sessionId} (${
        latest.packageName
      }) nativeStatus=${latest.nativeStatus}${
        latest.nativeError ? `: ${latest.nativeError}` : ''
      }`,
      fix:
        latest.nativeStatus === 'success'
          ? undefined
          : 'Fix the native error above and record again; JS-only analysis still works',
    });
  }

  if (options.sourceMap) {
    let map:
      | { x_hermes_function_offsets?: Record<string, number[]> }
      | undefined;
    try {
      map = JSON.parse(fs.readFileSync(options.sourceMap, 'utf8'));
    } catch (error) {
      add({
        check: 'sourcemap',
        status: 'fail',
        detail: `Cannot read ${options.sourceMap}: ${(error as Error).message}`,
        fix: 'Build the release app; the composed map is under android/app/build/generated/sourcemaps/react/release/',
      });
    }
    if (map && latest && latestPath) {
      try {
        const dir = latestPath.slice(0, -'/session.json'.length);
        const profile = JSON.parse(
          adb('shell', 'cat', `${dir}/hermes.cpuprofile`)
        ) as HermesProfile;
        const { checked, matched } = sourceMapMatch(map, profile);
        add(
          !checked
            ? {
                check: 'sourcemap',
                status: 'warn',
                detail: `cannot verify against session ${latest.sessionId}: ${
                  map.x_hermes_function_offsets
                    ? 'it has no bytecode frames (debug build?)'
                    : 'the map has no Hermes function offsets'
                }`,
              }
            : matched >= checked * 0.8
            ? {
                check: 'sourcemap',
                status: 'ok',
                detail: `matches session ${latest.sessionId} (${matched}/${checked} functions)`,
              }
            : {
                check: 'sourcemap',
                status: 'fail',
                detail: `does not match session ${latest.sessionId} (${matched}/${checked} functions)`,
                fix: 'Use the composed source map from the exact build that recorded the session',
              }
        );
      } catch (error) {
        add({
          check: 'sourcemap',
          status: 'fail',
          detail: (error as Error).message,
          fix: 'Use the composed source map from the exact build that recorded the session',
        });
      }
    } else if (map) {
      add({
        check: 'sourcemap',
        status: 'ok',
        detail: 'readable (no session to verify it against)',
      });
    }
  }
  return checks;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  return (
    checks
      .map(
        (c) =>
          `${icon[c.status]} ${c.check}: ${c.detail}${
            c.fix ? `\n    fix: ${c.fix}` : ''
          }`
      )
      .join('\n') + '\n'
  );
}
