import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { adbFailure, adbHint, MAX_BUFFER } from './adb';
import { ProfilerError } from './errors';
import type { HermesProfile, ProfileSessionManifest } from './mergeProfiles';
import {
  EXPORT_DIR,
  latestExportedSession,
  listExportedSessions,
  type AdbRunner,
} from './pullMerge';
import { sourceMapMatch, symbolicateFrames } from './symbolicate';

export interface DoctorCheck {
  check: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** Command or action that resolves a warn/fail. */
  fix?: string;
}

const ADB_TIMEOUT_MS = 15000;
/** Reading a long recording's profile over USB can take a while. */
const PROFILE_TIMEOUT_MS = 120000;
const RELEASE_MAP =
  'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map';
const LEGACY_FLOW = (appId?: string) =>
  `record with startProfiling() / stopProfiling(true) (Hermes only) and convert with \`npx react-native-release-profiler --fromDownload --appId ${
    appId ?? '<app id>'
  } --sourcemap-path <map>\``;

/** `adb devices` → serial and state ("device", "unauthorized", "offline", ...). */
function parseDevices(output: string) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [serial = '', state = ''] = line.split('\t');
      return { serial: serial.trim(), state: state.trim() };
    })
    .filter((device) => device.serial);
}

const stateFix = (state: string) =>
  state === 'unauthorized'
    ? 'Unlock the device and accept the USB debugging prompt'
    : state === 'offline'
    ? 'Reconnect the device (or run `adb kill-server`)'
    : `The device is in "${state}" state; boot it normally with USB debugging enabled`;

/** "YYYY-MM-DD HH:MM:SS" in device local time, from `dumpsys package` or `stat -c %y`. */
const LOCAL_TIME = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/;

/** Environment checks for recording and merging, each with a concrete fix. */
export async function runDoctor(options: {
  device?: string;
  appId?: string;
  sourceMap?: string;
  /** Per adb call (default 15 s); a wedged adb server must not hang doctor. */
  adbTimeoutMs?: number;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const adbRaw: AdbCall = (
    args,
    timeout = options.adbTimeoutMs ?? ADB_TIMEOUT_MS,
    serial
  ) => {
    try {
      return execFileSync('adb', serial ? ['-s', serial, ...args] : args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        maxBuffer: MAX_BUFFER,
        env: process.env,
      });
    } catch (error) {
      throw adbFailure(args, error);
    }
  };

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

  const session = await deviceChecks(options, add, adbRaw);
  if (options.sourceMap)
    add(await sourceMapCheck(options.sourceMap, options.appId, session));
  return checks;
}

type AdbCall = (args: string[], timeout?: number, serial?: string) => string;
type DeviceCall = (args: string[], timeout?: number) => string;

interface SessionToVerify {
  id: string;
  manifest: ProfileSessionManifest;
  run: DeviceCall;
}

/** Device, Android, app and session checks. Returns the session to check the map against. */
async function deviceChecks(
  options: { device?: string; appId?: string },
  add: (check: DoctorCheck) => void,
  adbRaw: AdbCall
): Promise<SessionToVerify | undefined> {
  try {
    adbRaw(['version']);
  } catch (error) {
    const message = (error as Error).message;
    add({
      check: 'adb',
      status: 'fail',
      detail: message.includes('not on PATH') ? 'adb is not on PATH' : message,
      fix: message.includes('not on PATH')
        ? 'Install Android platform-tools and add them to PATH'
        : 'Restart the adb server: `adb kill-server && adb start-server`',
    });
    return undefined;
  }
  let devices: { serial: string; state: string }[];
  try {
    devices = parseDevices(adbRaw(['devices']));
  } catch (error) {
    add({
      check: 'device',
      status: 'fail',
      detail: (error as Error).message,
      fix: 'Restart the adb server: `adb kill-server && adb start-server`',
    });
    return undefined;
  }
  const fromEnv = !options.device && !!process.env.ANDROID_SERIAL;
  const requested = options.device ?? process.env.ANDROID_SERIAL;
  const listed = devices
    .map(({ serial, state }) => `${serial} (${state})`)
    .join(', ');
  const target = requested
    ? devices.find((device) => device.serial === requested)
    : devices.length === 1
    ? devices[0]
    : undefined;
  if (!target) {
    add(
      requested
        ? {
            check: 'device',
            status: 'fail',
            detail: `${requested}${
              fromEnv ? ' (from ANDROID_SERIAL)' : ''
            } is not connected; ${
              devices.length ? `connected: ${listed}` : 'no device is connected'
            }`,
            fix: devices.length
              ? `Pass a serial listed by \`adb devices\` to --device${
                  fromEnv ? ' (or unset ANDROID_SERIAL)' : ''
                }`
              : 'Connect a device with USB debugging enabled and accept the prompt',
          }
        : devices.length
        ? {
            check: 'device',
            status: 'fail',
            detail: `${devices.length} devices connected: ${listed}`,
            fix: 'Pass --device <serial> (or set ANDROID_SERIAL)',
          }
        : {
            check: 'device',
            status: 'fail',
            detail: 'No device connected',
            fix: 'Connect a device with USB debugging enabled and accept the prompt',
          }
    );
    return undefined;
  }
  if (target.state !== 'device') {
    add({
      check: 'device',
      status: 'fail',
      detail: `${target.serial} is ${target.state}`,
      fix: stateFix(target.state),
    });
    return undefined;
  }
  add({
    check: 'device',
    status: 'ok',
    detail: `${target.serial}${fromEnv ? ' (from ANDROID_SERIAL)' : ''}`,
  });

  const run: DeviceCall = (args, timeout) =>
    adbRaw(args, timeout, target.serial);
  try {
    return await sessionChecks(options.appId, run, add);
  } catch (error) {
    // A device that drops out (or an adb timeout) mid-run is a device problem.
    const message = (error as Error).message;
    add({
      check: 'device',
      status: 'fail',
      detail: `${target.serial} stopped responding: ${message}`,
      fix:
        adbHint(message) ??
        'Check the USB connection and `adb devices`, then run doctor again',
    });
    return undefined;
  }
}

async function sessionChecks(
  appId: string | undefined,
  run: DeviceCall,
  add: (check: DoctorCheck) => void
): Promise<SessionToVerify | undefined> {
  const api = Number(run(['shell', 'getprop', 'ro.build.version.sdk']).trim());
  const sessionsSupported = api >= 35;
  add(
    sessionsSupported
      ? { check: 'android-api', status: 'ok', detail: `API ${api}` }
      : {
          check: 'android-api',
          status: 'warn',
          detail: `API ${api}: native sampling and profiling sessions need Android 15 (API 35); only Hermes profiling works`,
          fix: `Use an Android 15+ device or emulator, or ${LEGACY_FLOW(
            appId
          )}`,
        }
  );
  if (sessionsSupported) {
    const limiter = run([
      'shell',
      'device_config',
      'get',
      'profiling_testing',
      'rate_limiter.disabled',
    ]).trim();
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

  if (appId) {
    let installed: boolean;
    try {
      installed = run(['shell', 'pm', 'path', appId]).startsWith('package:');
    } catch (error) {
      // `pm path` exits 1 for an unknown package; adb's own failures keep propagating.
      if (adbHint((error as Error).message) || /timed out/.test(String(error)))
        throw error;
      installed = false;
    }
    add(
      installed
        ? { check: 'app', status: 'ok', detail: `${appId} installed` }
        : {
            check: 'app',
            status: 'fail',
            detail: `${appId} is not installed`,
            fix: 'Install the release build you want to profile',
          }
    );
  }

  const runner: AdbRunner = (args) => run(args);
  const { ids, incomplete } = listExportedSessions(runner);
  const skipped = incomplete.length
    ? `; skipped ${
        incomplete.length
      } incomplete export(s) (app stopped while exporting): ${incomplete.join(
        ', '
      )}`
    : '';
  let latest: ReturnType<typeof latestExportedSession>;
  try {
    latest = latestExportedSession(runner, ids, appId);
  } catch (error) {
    if (!(error instanceof ProfilerError) || error.code === 'E_ADB')
      throw error;
    // pull-merge and analyze --pull would stop at this session too.
    add({
      check: 'sessions',
      status: 'fail',
      detail: error.message,
      fix: 'Pass the ID of a complete session to pull-merge/analyze, or delete the broken export and record again',
    });
    return undefined;
  }
  if (!latest) {
    add({
      check: 'sessions',
      status: 'warn',
      detail: `No exported sessions${
        appId ? ` for ${appId}` : ''
      } in Download/release-profiler${skipped}`,
      fix: sessionsSupported
        ? 'Record with startProfilingSession() and finish with session.stop(true)'
        : `Sessions need Android 15 (API 35); on this device ${LEGACY_FLOW(
            appId
          )}`,
    });
    return undefined;
  }
  const { manifest } = latest;
  add({
    check: 'sessions',
    status: manifest.nativeStatus === 'success' ? 'ok' : 'warn',
    detail: `${ids.length} exported; latest ${latest.id} (${
      manifest.packageName
    }) nativeStatus=${manifest.nativeStatus}${
      manifest.nativeError ? `: ${manifest.nativeError}` : ''
    }${skipped}`,
    fix:
      manifest.nativeStatus === 'success'
        ? undefined
        : 'Fix the native error above and record again; JS-only analysis still works',
  });
  return { id: latest.id, manifest, run };
}

/** The app's install time when it was (re)installed after the session was exported: that
 * session then cannot vouch for the installed build. Compares device-local times. */
function installedAfterSession(
  session: SessionToVerify,
  packageName: string | undefined
): { installed: string } | undefined {
  if (!packageName) return undefined;
  try {
    const installed = session
      .run(['shell', 'dumpsys', 'package', packageName])
      .match(new RegExp(`lastUpdateTime=${LOCAL_TIME.source}`))?.[1];
    const exported = session
      .run([
        'shell',
        'stat',
        '-c',
        '%y',
        `${EXPORT_DIR}/${session.id}/session.json`,
      ])
      .match(LOCAL_TIME)?.[1];
    return installed && exported && exported < installed
      ? { installed }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Check the map the way analyze/pull-merge will use it: against the session they would pull. */
async function sourceMapCheck(
  file: string,
  appId: string | undefined,
  session: SessionToVerify | undefined
): Promise<DoctorCheck> {
  let text: string;
  let map: { x_hermes_function_offsets?: Record<string, number[]> };
  try {
    text = fs.readFileSync(file, 'utf8');
    map = JSON.parse(text);
  } catch (error) {
    return {
      check: 'sourcemap',
      status: 'fail',
      detail: `Cannot read ${file}: ${(error as Error).message}`,
      fix: `Build the release app; the composed map is ${RELEASE_MAP}`,
    };
  }
  const hasOffsets = Object.values(map.x_hermes_function_offsets ?? {}).some(
    (offsets) => offsets?.length
  );
  // Without a session: release sessions need the composed Hermes map; others resolve nothing.
  const standalone = (why: string, fix?: string): DoctorCheck =>
    hasOffsets
      ? {
          check: 'sourcemap',
          status: fix ? 'warn' : 'ok',
          detail: `composed Hermes source map (${why})`,
          ...(fix ? { fix } : {}),
        }
      : {
          check: 'sourcemap',
          status: 'fail',
          detail: `not the composed Hermes source map of a release build (no x_hermes_function_offsets), so release sessions cannot be symbolicated (${why})`,
          fix: `Use ${RELEASE_MAP} from the release build`,
        };
  if (!session) return standalone('no session to verify it against');

  const { id, manifest } = session;
  let profile: HermesProfile;
  try {
    const name = path.posix.basename(
      manifest.hermesProfilePath || 'hermes.cpuprofile'
    );
    profile = JSON.parse(
      session.run(
        ['shell', 'cat', `${EXPORT_DIR}/${id}/${name}`],
        PROFILE_TIMEOUT_MS
      )
    );
    if (!profile?.stackFrames || !profile.samples?.length)
      throw new Error('it has no samples or stack frames');
  } catch (error) {
    // A transport or session problem says nothing about the map.
    return standalone(
      `could not read session ${id}'s Hermes profile to verify it: ${
        (error as Error).message
      }`,
      'Check the device connection and run doctor again; if the session is incomplete, record a new one'
    );
  }

  const stale = installedAfterSession(session, manifest.packageName ?? appId);
  let rejection: ProfilerError | undefined;
  try {
    await symbolicateFrames(profile, text);
  } catch (error) {
    if (!(error instanceof ProfilerError))
      return {
        check: 'sourcemap',
        status: 'fail',
        detail: `Cannot use ${file} as a source map: ${
          (error as Error).message
        }`,
        fix: `Build the release app; the composed map is ${RELEASE_MAP}`,
      };
    rejection = error;
  }
  if (stale)
    return rejection
      ? standalone(
          `the latest session ${id} was recorded before ${manifest.packageName} was installed at ${stale.installed}, so it cannot verify this map`,
          'Record a session with the installed build, then run doctor again'
        )
      : {
          check: 'sourcemap',
          status: 'warn',
          detail: `matches session ${id}, but that session was recorded before ${manifest.packageName} was installed at ${stale.installed}`,
          fix: 'If you rebuilt since, use the new build’s map; record a session with the installed build and run doctor again',
        };
  if (!rejection) {
    const { checked, matched } = sourceMapMatch(map, profile);
    return {
      check: 'sourcemap',
      status: 'ok',
      detail: checked
        ? `matches session ${id} (${matched}/${checked} functions)`
        : `resolves session ${id} (debug build: source positions)`,
    };
  }
  const fix =
    rejection.code === 'E_SOURCEMAP_UNRESOLVED'
      ? `Use the composed release map (${RELEASE_MAP})`
      : 'Use the composed source map from the exact build that recorded the session';
  // Without --appId the latest session may belong to another app.
  return appId
    ? {
        check: 'sourcemap',
        status: 'fail',
        detail: `session ${id}: ${rejection.message} [${rejection.code}]`,
        fix,
      }
    : {
        check: 'sourcemap',
        status: 'warn',
        detail: `does not fit the latest session ${id} (${manifest.packageName}): ${rejection.message} [${rejection.code}]`,
        fix: `Pass --appId <your app> to check against your app's sessions; if ${manifest.packageName} is your app: ${fix}`,
      };
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
