// Legacy Hermes-only flow (`startProfiling()` / `stopProfiling()`), based on
// https://github.com/react-native-community/cli/blob/main/packages/cli-hermes/src/profileHermes/downloadProfile.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import transformer from '@margelo/hermes-profile-transformer';
import { adb, adbToFile, shellQuote } from './adb';
import { ProfilerError } from './errors';
import getConfig from './getConfig';
import { getMetroBundleOptions } from './getMetroBundleOptions';
import { logger } from './logger';
import type { HermesProfile } from './mergeProfiles';
import { hasRewrittenFrames } from './symbolicate';
import { functionLevelProfile, withoutNodeIds } from './legacyFrames';
import {
  findSourcemap,
  flattenSourceMap,
  generateSourcemap,
  isBytecodeProfile,
  sourceMapFits,
} from './sourcemapUtils';

const DOWNLOADS = '/sdcard/Download';
/** stopProfiling(true) saves `<name>.cpuprofile`; Android 10+ adds `.txt` (MIME text/plain). */
const PROFILE_FILE = /\.cpuprofile(\.txt)?$/;
/** Warn when the profile picked from Downloads is older than this. */
const STALE_AFTER_S = 15 * 60;

export interface LegacyOptions {
  /** Convert this local file instead of pulling one. */
  local?: string;
  /** Pull from /sdcard/Download (stopProfiling(true)) instead of the app cache. */
  fromDownload?: boolean;
  filename?: string;
  sourcemapPath?: string;
  raw?: boolean;
  generateSourcemap?: boolean;
  port?: string;
  appId?: string;
  appIdSuffix?: string;
  device?: string;
  output?: string;
}

export interface LegacyResult {
  /** Absolute path of the written file. */
  output: string;
  source: 'downloads' | 'cache' | 'local';
  /** The profile that was converted (device path, or the local file). */
  profile: string;
  packageName?: string;
  /** App that saved the profile to Downloads (Android 10+). */
  owner?: string;
  /** When the profile was saved, from the device clock. */
  savedAt?: string;
  ageSeconds?: number;
  sourceMap: string | null;
  raw: boolean;
  warnings: string[];
}

export interface DeviceProfile {
  name: string;
  /** Modification time, seconds since the epoch. */
  mtime: number;
  /** MediaStore owner package (Android 10+); undefined when unknown. */
  owner?: string;
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown time';
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

/** `x.cpuprofile.txt` → `x`, so outputs are `x-converted.json` / `x.cpuprofile`. */
export function profileBaseName(file: string): string {
  return path
    .basename(file)
    .replace(/\.txt$/, '')
    .replace(/\.cpuprofile$/, '');
}

/**
 * The profile in Downloads to convert: the newest one saved by `packageName` (MediaStore
 * owner). Without ownership, only an unambiguous single file is picked.
 */
export function pickDownloadProfile(
  files: DeviceProfile[],
  packageName: string | undefined,
  now: number
): DeviceProfile {
  const newest = [...files].sort((a, b) => b.mtime - a.mtime);
  const describe = (list: DeviceProfile[]) =>
    list
      .slice(0, 5)
      .map(
        (file) =>
          `${file.name} (${formatAge(now - file.mtime)} old, ${
            file.owner ?? 'owner unknown'
          })`
      )
      .join(', ') + (list.length > 5 ? `, … ${list.length - 5} more` : '');
  if (!newest.length)
    throw new ProfilerError(
      'E_NO_PROFILE',
      `No Hermes profile (*.cpuprofile) in ${DOWNLOADS}. In the app, call stopProfiling(true) to save the profile to Downloads, then run this again.`
    );
  const unknown = newest.filter((file) => !file.owner);
  if (packageName) {
    const owned = newest.find((file) => file.owner === packageName);
    if (owned) return owned;
    if (unknown.length === 1) return unknown[0]!;
    if (unknown.length > 1)
      throw new ProfilerError(
        'E_USAGE',
        `${
          unknown.length
        } profiles in ${DOWNLOADS} and the device does not say which app saved them; pass --filename <name>: ${describe(
          unknown
        )}`
      );
    throw new ProfilerError(
      'E_NO_PROFILE',
      `No profile saved by ${packageName} in ${DOWNLOADS}; found only profiles from other apps: ${describe(
        newest
      )}. In ${packageName}, call stopProfiling(true), or pass --filename <name> to convert one of these.`
    );
  }
  const owners = new Set(newest.map((file) => file.owner));
  if (newest.length === 1 || (owners.size === 1 && !unknown.length))
    return newest[0]!;
  throw new ProfilerError(
    'E_USAGE',
    `${
      newest.length
    } profiles in ${DOWNLOADS}; pass --appId <app id> or --filename <name> to choose: ${describe(
      newest
    )}`
  );
}

/** `date +%s` then `stat -c '%Y %n'` output → device time and files. */
function parseStat(output: string): { now: number; files: DeviceProfile[] } {
  const [first = '', ...lines] = output.split(/\r?\n/);
  const files: DeviceProfile[] = [];
  for (const line of lines) {
    const match = line.trim().match(/^(\d+) (.+)$/);
    if (match)
      files.push({
        mtime: Number(match[1]),
        name: path.posix.basename(match[2]!),
      });
  }
  return { now: Number(first.trim()), files };
}

/** MediaStore owners of files directly in Download (Android 10+); undefined if unavailable. */
function downloadOwners(device?: string): Map<string, string> | undefined {
  let output: string;
  try {
    output = adb(
      device,
      [
        'shell',
        'content query --uri content://media/external/downloads --projection _display_name:owner_package_name:relative_path',
      ],
      { timeout: 15000 }
    );
  } catch {
    return undefined;
  }
  const owners = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /_display_name=(.*?), owner_package_name=(.*?), relative_path=(.*)$/
    );
    if (!match || match[3]!.trim().replace(/\/$/, '') !== 'Download') continue;
    if (match[2] && match[2] !== 'NULL') owners.set(match[1]!, match[2]);
  }
  return owners;
}

function findDownloadProfile(
  device: string | undefined,
  packageName: string | undefined,
  filename: string | undefined
): { file: DeviceProfile; now: number } {
  if (filename) {
    // Accept the path stopProfiling() returned and the name without Android's `.txt`.
    const base = path.posix.basename(filename);
    const names = base.endsWith('.txt') ? [base] : [base, `${base}.txt`];
    const { now, files } = parseStat(
      adb(device, [
        'shell',
        `date +%s; stat -c '%Y %n' ${names
          .map((name) => shellQuote(`${DOWNLOADS}/${name}`))
          .join(' ')} 2>/dev/null; true`,
      ])
    );
    const file = files[0];
    if (!file)
      throw new ProfilerError(
        'E_NO_PROFILE',
        `No ${names
          .map((name) => `${DOWNLOADS}/${name}`)
          .join(' or ')} on the device`
      );
    file.owner = downloadOwners(device)?.get(file.name);
    return { file, now };
  }
  const { now, files } = parseStat(
    adb(device, [
      'shell',
      `date +%s; stat -c '%Y %n' ${DOWNLOADS}/*.cpuprofile ${DOWNLOADS}/*.cpuprofile.txt 2>/dev/null; true`,
    ])
  );
  const profiles = files.filter((file) => PROFILE_FILE.test(file.name));
  const owners = profiles.length ? downloadOwners(device) : undefined;
  profiles.forEach((file) => (file.owner = owners?.get(file.name)));
  return { file: pickDownloadProfile(profiles, packageName, now), now };
}

/** run-as only works for debuggable builds; explain the release-build route instead. */
function runAsError(
  packageName: string,
  message: string
): ProfilerError | undefined {
  if (/not debuggable/i.test(message))
    return new ProfilerError(
      'E_USAGE',
      `${packageName} is not debuggable (release build), so its cache cannot be read over adb. In the app call stopProfiling(true) to also save the profile to Downloads, then run with --fromDownload --appId ${packageName}.`
    );
  if (/unknown package|is unknown|not installed/i.test(message))
    return new ProfilerError(
      'E_USAGE',
      `${packageName} is not installed on the device; pass the right --appId`
    );
  return undefined;
}

/** Run `command` as the app (cache access); adb failures become actionable errors. */
function runAs<T>(
  packageName: string,
  command: string,
  run: (args: string[]) => T
): T {
  try {
    return run(['shell', `run-as ${shellQuote(packageName)} ${command}`]);
  } catch (error) {
    throw runAsError(packageName, (error as Error).message) ?? error;
  }
}

/** `keepAddresses`: also keep funcVirtAddr/offset, so `analyze --profile` can verify the
 * source map against a raw pull (the converter needs them removed). */
function maybeAddLineAndColumn(file: string, keepAddresses = false): void {
  const profileJson = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stackFrames = profileJson.stackFrames;
  if (stackFrames !== undefined) {
    for (const key of Object.keys(stackFrames)) {
      const stackFrame = stackFrames[key];
      if (stackFrame.funcVirtAddr && stackFrame.offset) {
        stackFrame.line = `${1}`;
        stackFrame.column = `${
          parseInt(stackFrame.funcVirtAddr) + parseInt(stackFrame.offset) + 1
        }`;
        if (!keepAddresses) {
          delete stackFrame.funcVirtAddr;
          delete stackFrame.offset;
        }
      }
    }
    fs.writeFileSync(file, JSON.stringify(profileJson));
  }
}

/** The transformer drops the profile's process/thread names; keep them (appended after the
 * converted events) so trace viewers label the JS thread. */
function threadNames(profile: HermesProfile): object[] {
  const events: any[] = (profile as { traceEvents?: any[] }).traceEvents ?? [];
  return events
    .filter(
      (event) =>
        event?.ph === 'M' &&
        (event.name === 'process_name' || event.name === 'thread_name') &&
        Number.isSafeInteger(Number(event.pid)) &&
        Number.isSafeInteger(Number(event.tid))
    )
    .map((event) => ({
      name: event.name,
      ph: 'M',
      pid: Number(event.pid),
      tid: Number(event.tid),
      args: event.args,
    }));
}

/** `--output` may name a file or an existing directory. */
function resolveOutput(output: string | undefined, name: string): string {
  if (!output) return path.resolve(name);
  return fs.existsSync(output) && fs.statSync(output).isDirectory()
    ? path.resolve(output, name)
    : path.resolve(output);
}

/** Pull (or read) a Hermes profile and convert it to Chrome trace format, or keep it raw. */
export async function downloadProfile(
  options: LegacyOptions
): Promise<LegacyResult> {
  const { local, device } = options;
  const warnings: string[] = [];
  // `react-native config` is slow and needs the RN CLI: only ask when an option is missing.
  let config: Awaited<ReturnType<typeof getConfig>> | undefined;
  let configError = '';
  const projectConfig = async () => {
    if (config === undefined) {
      try {
        config = await getConfig();
      } catch (error) {
        config = null;
        configError = (error as Error).message.split('\n')[0] ?? '';
      }
    }
    return config;
  };

  if (local && !fs.existsSync(local))
    throw new ProfilerError('E_USAGE', `Profile not found: ${local}`);
  if (options.sourcemapPath && !fs.existsSync(options.sourcemapPath))
    throw new ProfilerError(
      'E_USAGE',
      `Source map not found: ${options.sourcemapPath}`
    );

  let packageName: string | undefined;
  if (!local) {
    const appId =
      options.appId || (await projectConfig())?.project.android.packageName;
    packageName =
      [appId, options.appIdSuffix].filter(Boolean).join('.') || undefined;
    if (!packageName && !options.fromDownload)
      throw new ProfilerError(
        'E_USAGE',
        `Failed to retrieve the package name from the project's Android manifest file${
          configError ? ` (${configError})` : ''
        }. Please provide the package name with the --appId flag.`
      );
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rn-release-profiler-')
  );
  try {
    let source: LegacyResult['source'];
    let profilePath: string;
    let name: string;
    let picked: { file: DeviceProfile; now: number } | undefined;
    if (local) {
      source = 'local';
      name = path.basename(local);
      profilePath = path.resolve(local);
    } else if (options.fromDownload) {
      source = 'downloads';
      picked = findDownloadProfile(device, packageName, options.filename);
      name = picked.file.name;
      profilePath = `${DOWNLOADS}/${name}`;
    } else {
      source = 'cache';
      const files = options.filename
        ? [path.posix.basename(options.filename)]
        : runAs(packageName!, 'ls -t cache/', (args) => adb(device, args))
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter((entry) => PROFILE_FILE.test(entry));
      if (!files[0])
        throw new ProfilerError(
          'E_NO_PROFILE',
          `No profile in ${packageName}'s cache/ directory. Record one with startProfiling() / stopProfiling() first.`
        );
      name = files[0];
      profilePath = `cache/${name}`;
    }

    const savedAt = picked
      ? new Date(picked.file.mtime * 1000).toISOString()
      : undefined;
    const age = picked ? picked.now - picked.file.mtime : NaN;
    const ageSeconds = Number.isFinite(age) ? age : undefined;
    const owner = picked?.file.owner;
    logger.info(
      `File to be pulled: ${profilePath}${
        ageSeconds !== undefined
          ? ` (saved ${formatAge(ageSeconds)} ago${
              owner ? ` by ${owner}` : ''
            })`
          : ''
      }`
    );
    const warn = (warning: string) => {
      warnings.push(warning);
      logger.warn(warning);
    };
    if (picked && packageName && owner !== packageName)
      warn(
        owner
          ? `${name} was saved by ${owner}, not ${packageName}`
          : `Could not confirm that ${name} was saved by ${packageName}: the device does not report which app saved it`
      );
    if (ageSeconds !== undefined && ageSeconds > STALE_AFTER_S)
      warn(
        `${name} was saved ${formatAge(
          ageSeconds
        )} ago. If you just recorded, check that the app called stopProfiling(true): without true the profile stays in the app cache.`
      );

    const tempFile = path.join(tempDir, name);
    if (source === 'local') fs.copyFileSync(local!, tempFile);
    else if (source === 'downloads')
      adbToFile(device, ['shell', `cat ${shellQuote(profilePath)}`], tempFile);
    else
      runAs(packageName!, `cat ${shellQuote(profilePath)}`, (args) =>
        adbToFile(device, args, tempFile)
      );

    let profile: HermesProfile;
    try {
      profile = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    } catch (error) {
      throw new ProfilerError(
        'E_HERMES_PROFILE',
        `${profilePath} is not a Hermes profile: ${(error as Error).message}`
      );
    }
    const empty = !Array.isArray(profile?.samples) || !profile.samples.length;
    const result = {
      source,
      profile: profilePath,
      packageName,
      owner,
      savedAt,
      ageSeconds,
      raw: !!options.raw,
      warnings,
    };

    if (options.raw) {
      const output = resolveOutput(
        options.output,
        `${profileBaseName(name)}.cpuprofile`
      );
      maybeAddLineAndColumn(tempFile, true);
      fs.copyFileSync(tempFile, output);
      if (empty)
        warn(
          `${profilePath} has no samples: nothing was recorded between startProfiling() and stopProfiling()`
        );
      logger.success(`Successfully pulled the file to ${output}`);
      return { ...result, output, sourceMap: null };
    }
    if (empty)
      throw new ProfilerError(
        'E_HERMES_PROFILE',
        `${profilePath} has no samples: nothing was recorded between startProfiling() and stopProfiling()`
      );

    // One frame per JS function, positioned where the function is defined.
    fs.writeFileSync(tempFile, JSON.stringify(functionLevelProfile(profile)));
    const bundleOptions = getMetroBundleOptions(tempFile, 'localhost');

    // A map from another build "resolves" frames to the wrong code; refuse it.
    const checkMap = (map: string) => {
      const fit = sourceMapFits(map, profile);
      if (!fit.ok)
        throw new ProfilerError(
          'E_SOURCEMAP_MISMATCH',
          `Source map ${map} does not match this profile: ${fit.reason}`
        );
    };
    const port = options.port ?? '8081';
    let sourceMap = options.sourcemapPath;
    if (sourceMap) checkMap(sourceMap);
    else if (options.generateSourcemap) {
      sourceMap = await generateSourcemap(port, bundleOptions);
      if (sourceMap) checkMap(sourceMap);
    } else {
      sourceMap = await findSourcemap(
        await projectConfig(),
        port,
        bundleOptions,
        profile
      );
    }
    if (!sourceMap)
      warn(
        `Cannot find source maps, running the transformer without it. ${
          isBytecodeProfile(profile)
            ? 'Function names are kept but source files and lines will be missing. Pass --sourcemap-path with the composed map of the exact release build (android/app/build/generated/sourcemaps/react/release/index.android.bundle.map).'
            : 'Instructions on how to get source maps: set `bundleInDebug: true` in your app/build.gradle file, inside the `project.ext.react` map.'
        }`
      );

    if (sourceMap && hasRewrittenFrames(profile))
      warn(
        'This profile was saved by an older `--raw` pull without bytecode addresses, so the source map cannot be verified against it: use the map of the exact build that recorded it.'
      );

    // Run transformer tool to convert from Hermes to Chrome format
    const events = withoutNodeIds(
      await transformer(
        tempFile,
        sourceMap ? await flattenSourceMap(sourceMap) : undefined,
        'index.bundle'
      )
    );
    const output = resolveOutput(
      options.output,
      `${profileBaseName(name)}-converted.json`
    );
    // Convert to JSON in chunks because JSON.stringify() will fail for large
    // arrays with the error "RangeError: Invalid string length"
    const out = [...events, ...threadNames(profile)]
      .map((event: unknown) => JSON.stringify(event, undefined, 4))
      .join(',');
    fs.writeFileSync(output, '[' + out + ']', 'utf-8');
    logger.success(
      `Successfully converted to Chrome tracing format and pulled the file to ${output}`
    );
    return { ...result, output, sourceMap: sourceMap ?? null };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
