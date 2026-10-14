import fs from 'fs';
import path from 'path';
import { adb } from './adb';
import { logger } from './logger';
import { ProfilerError } from './errors';
import {
  mergeSession,
  type MergeFormat,
  type ProfileSessionManifest,
} from './mergeProfiles';

export const EXPORT_DIR = '/sdcard/Download/release-profiler';
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs one adb command on the selected device and returns stdout; throws on failure. */
export type AdbRunner = (args: string[]) => string;

/**
 * Exported sessions, newest first. A force-stop during export leaves MediaStore
 * `.pending-…` files (session.json missing or empty); those exports are skipped.
 */
export function listExportedSessions(run: AdbRunner): {
  ids: string[];
  incomplete: string[];
} {
  const output = run([
    'shell',
    `ls -1t ${EXPORT_DIR}/*/session.json 2>/dev/null; ls -1d ${EXPORT_DIR}/*/.pending-* 2>/dev/null; true`,
  ]);
  const ids: string[] = [];
  const incomplete = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const pending = line.match(/\/([0-9a-f-]{36})\/\.pending-[^/]*$/i)?.[1];
    if (pending) incomplete.add(pending);
    const id = line.match(/\/([0-9a-f-]{36})\/session\.json$/i)?.[1];
    if (id) ids.push(id);
  }
  return {
    ids: ids.filter((id) => !incomplete.has(id)),
    incomplete: [...incomplete],
  };
}

/** Read an exported session.json; adb failures stay E_ADB, unparsable files are E_SESSION_MANIFEST. */
export function readExportedManifest(
  run: AdbRunner,
  id: string
): ProfileSessionManifest {
  const file = `${EXPORT_DIR}/${id}/session.json`;
  const text = run(['shell', 'cat', file]);
  try {
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object')
      throw new Error('not a JSON object');
    return manifest;
  } catch (error) {
    throw new ProfilerError(
      'E_SESSION_MANIFEST',
      `Cannot parse ${file}: ${
        (error as Error).message
      }. Pass another session ID, or delete this broken export.`
    );
  }
}

/** The newest session (for `appId`, if given). Errors other than "another app" propagate. */
export function latestExportedSession(
  run: AdbRunner,
  ids: string[],
  appId?: string
): { id: string; manifest: ProfileSessionManifest } | undefined {
  for (const id of ids) {
    const manifest = readExportedManifest(run, id);
    if (!appId || manifest.packageName === appId) return { id, manifest };
  }
  return undefined;
}

/** E_NO_SESSIONS with advice that works on this device. */
function noSessionsError(
  run: AdbRunner,
  appId: string | undefined,
  incomplete: string[]
): ProfilerError {
  const scope = appId ? ` for ${appId}` : '';
  let api = NaN;
  try {
    api = Number(run(['shell', 'getprop', 'ro.build.version.sdk']).trim());
  } catch {}
  if (api > 0 && api < 35)
    return new ProfilerError(
      'E_NO_SESSIONS',
      `No exported sessions${scope}: this device runs API ${api} and profiling sessions need Android 15 (API 35) or newer. Record with startProfiling() / stopProfiling(true) (Hermes only) and convert it with \`npx react-native-release-profiler --fromDownload --appId ${
        appId ?? '<app id>'
      }\`, or analyze it with \`analyze --profile <file>\`.`
    );
  return new ProfilerError(
    'E_NO_SESSIONS',
    `No exported sessions found${scope}. Finish a recording with session.stop(true) first.${
      incomplete.length
        ? ` Skipped ${
            incomplete.length
          } incomplete export(s) (${incomplete.join(
            ', '
          )}): the app was stopped while exporting; record again.`
        : ''
    }`
  );
}

/** Download an exported session (the latest, optionally for one app) into its own directory. */
export function pullSession(options: {
  sessionId?: string;
  device?: string;
  directory: string;
  appId?: string;
}): { sessionId: string; directory: string } {
  const run: AdbRunner = (args) => adb(options.device, args);
  let sessionId = options.sessionId;
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
    throw new ProfilerError(
      'E_BAD_SESSION_ID',
      `Expected the session UUID shown by the app, not "${sessionId}". To merge a session already on disk, run \`npx react-native-release-profiler --merge-session <path/to/session.json> --sourcemap-path <map>\` (without pull-merge).`
    );
  }
  if (!sessionId) {
    const { ids, incomplete } = listExportedSessions(run);
    sessionId = options.appId
      ? latestExportedSession(run, ids, options.appId)?.id
      : ids[0];
    if (!sessionId) throw noSessionsError(run, options.appId, incomplete);
  } else {
    const entries = run([
      'shell',
      `ls -1a ${EXPORT_DIR}/${sessionId} 2>/dev/null; true`,
    ]).split(/\r?\n/);
    if (!entries.some((entry) => entry.trim()))
      throw new ProfilerError(
        'E_NO_SESSIONS',
        `Session ${sessionId} is not on the device (${EXPORT_DIR}/${sessionId} does not exist)`
      );
    if (entries.some((entry) => entry.startsWith('.pending-')))
      throw new ProfilerError(
        'E_SESSION_MANIFEST',
        `Session ${sessionId} was not exported completely: the app was stopped while exporting (.pending files in ${EXPORT_DIR}/${sessionId}). Record again.`
      );
  }
  const directory = path.resolve(options.directory);
  fs.mkdirSync(directory, { recursive: true });
  let destination = path.join(directory, sessionId);
  // Keep each download separate, including repeated pulls of the latest session.
  if (fs.existsSync(destination)) {
    destination = fs.mkdtempSync(`${destination}-`);
  } else {
    fs.mkdirSync(destination);
  }
  logger.info(`Pulling session ${sessionId} into ${destination}`);
  try {
    run(['pull', `${EXPORT_DIR}/${sessionId}/.`, destination]);
  } catch (error) {
    // Don't leave an empty download directory behind; keep any partially pulled files.
    try {
      fs.rmdirSync(destination);
    } catch {}
    throw error;
  }
  return { sessionId, directory: destination };
}

/** Download the complete export, retaining the originals even if merging fails. */
export async function pullMerge(options: {
  sessionId?: string;
  device?: string;
  directory: string;
  appId?: string;
  sourceMap: string;
  output: string;
  format?: MergeFormat;
}) {
  try {
    fs.accessSync(options.sourceMap, fs.constants.R_OK);
  } catch {
    throw new ProfilerError(
      'E_USAGE',
      `Cannot read source map ${options.sourceMap}`
    );
  }
  const pulled = pullSession(options);
  const result = await mergeSession({
    session: path.join(pulled.directory, 'session.json'),
    sourceMap: options.sourceMap,
    output: options.output,
    format: options.format,
  });
  return { ...result, sessionDirectory: pulled.directory };
}
