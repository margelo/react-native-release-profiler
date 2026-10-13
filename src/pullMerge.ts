import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from '@react-native-community/cli-tools';
import { mergeSession } from './mergeProfiles';

/** Download the complete export, retaining the originals even if merging fails. */
export async function pullMerge(options: {
  sessionId?: string;
  device?: string;
  directory: string;
  sourceMap: string;
  output: string;
  format?: 'perfetto' | 'simpleperf';
}) {
  const deviceArgs = options.device ? ['-s', options.device] : [];
  let sessionId = options.sessionId;
  if (!sessionId) {
    const listing = execFileSync(
      'adb',
      [
        ...deviceArgs,
        'shell',
        'ls -1t /sdcard/Download/release-profiler/*/session.json 2>/dev/null || true',
      ],
      { encoding: 'utf8' }
    );
    sessionId = listing
      .split(/\r?\n/)
      .map((entry) => entry.match(/\/([0-9a-f-]{36})\/session\.json$/i)?.[1])
      .find((id) => id !== undefined);
    if (!sessionId) {
      throw new Error(
        'No exported sessions found. Finish a recording with session.stop(true) first.'
      );
    }
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionId
    )
  ) {
    throw new Error('Expected the session UUID shown by the app');
  }
  fs.accessSync(options.sourceMap, fs.constants.R_OK);
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
    execFileSync(
      'adb',
      [
        ...deviceArgs,
        'pull',
        `/sdcard/Download/release-profiler/${sessionId}/.`,
        destination,
      ],
      { stdio: 'inherit' }
    );
  } catch (error) {
    // Don't leave an empty download directory behind; keep any partially pulled files.
    try {
      fs.rmdirSync(destination);
    } catch {}
    throw error;
  }
  return mergeSession({
    session: path.join(destination, 'session.json'),
    sourceMap: options.sourceMap,
    output: options.output,
    format: options.format,
  });
}
