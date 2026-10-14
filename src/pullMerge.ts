import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from '@react-native-community/cli-tools';
import { ProfilerError } from './errors';
import { mergeSession, type MergeFormat } from './mergeProfiles';

const EXPORT_DIR = '/sdcard/Download/release-profiler';

function adb(device: string | undefined, args: string[]): string {
  try {
    return execFileSync('adb', [...(device ? ['-s', device] : []), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new ProfilerError('E_ADB', `adb ${args[0]} failed: ${detail}`);
  }
}

/** Download an exported session (the latest, optionally for one app) into its own directory. */
export function pullSession(options: {
  sessionId?: string;
  device?: string;
  directory: string;
  appId?: string;
}): { sessionId: string; directory: string } {
  let sessionId = options.sessionId;
  if (!sessionId) {
    const candidates = adb(options.device, [
      'shell',
      `ls -1t ${EXPORT_DIR}/*/session.json 2>/dev/null || true`,
    ])
      .split(/\r?\n/)
      .map((entry) => entry.match(/\/([0-9a-f-]{36})\/session\.json$/i)?.[1])
      .filter((id): id is string => id !== undefined);
    sessionId = options.appId
      ? candidates.find((id) => {
          try {
            const manifest = JSON.parse(
              adb(options.device, [
                'shell',
                'cat',
                `${EXPORT_DIR}/${id}/session.json`,
              ])
            );
            return manifest.packageName === options.appId;
          } catch {
            return false;
          }
        })
      : candidates[0];
    if (!sessionId) {
      throw new ProfilerError(
        'E_NO_SESSIONS',
        `No exported sessions found${
          options.appId ? ` for ${options.appId}` : ''
        }. Finish a recording with session.stop(true) first.`
      );
    }
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionId
    )
  ) {
    throw new ProfilerError(
      'E_BAD_SESSION_ID',
      'Expected the session UUID shown by the app'
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
    adb(options.device, ['pull', `${EXPORT_DIR}/${sessionId}/.`, destination]);
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
