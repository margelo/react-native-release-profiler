import fs from 'fs';
import path from 'path';
import type { AnalysisReport } from './analyze';
import { ProfilerError } from './errors';
import { parseSourceMap } from './symbolicate';

// Validation of CLI arguments: anything a user can mistype fails with a documented code
// (E_USAGE, E_OUTPUT_CONFLICT) before any work, instead of a raw Node error (E_UNKNOWN).

/** A path the user passed must be a readable file. */
export function requireFile(file: string, what: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ProfilerError('E_USAGE', `${what} not found: ${file}`);
  }
  if (!stat.isFile())
    throw new ProfilerError('E_USAGE', `${what} is not a file: ${file}`);
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new ProfilerError('E_USAGE', `Cannot read ${what} ${file}`);
  }
  return file;
}

/** Before pulling from the device: a map that cannot be parsed would waste the download. */
export function checkSourceMapFile(file: string) {
  try {
    parseSourceMap(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ProfilerError('E_USAGE', `${file}: ${(error as Error).message}`);
  }
}

/** session.json, or the session directory that contains it. */
export function sessionManifestPath(session: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(session);
  } catch {
    throw new ProfilerError('E_USAGE', `Session not found: ${session}`);
  }
  if (!stat.isDirectory()) return session;
  const manifest = path.join(session, 'session.json');
  if (!fs.existsSync(manifest))
    throw new ProfilerError(
      'E_USAGE',
      `${session} is not a session directory (no session.json)`
    );
  return manifest;
}

/** `--long-task` / `--top`: a typo such as `50ms` must not silently empty the report. */
export function positiveNumber(value: unknown, flag: string, integer: boolean) {
  const text = String(value).trim();
  const number = Number(text);
  if (!(integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(text) || !(number > 0))
    throw new ProfilerError(
      'E_USAGE',
      `${flag} must be a positive ${
        integer ? 'integer' : 'number of milliseconds'
      } (got '${value}')`
    );
  return number;
}

/** Create the output's directory and fail before any work when it cannot be written. */
export function prepareOutput(output: string) {
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(output).isDirectory();
  } catch {}
  if (isDirectory)
    throw new ProfilerError(
      'E_USAGE',
      `--output ${output} is a directory; pass a file path`
    );
  const directory = path.dirname(path.resolve(output));
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(
      fs.existsSync(output) ? output : directory,
      fs.constants.W_OK
    );
  } catch (error) {
    throw new ProfilerError(
      'E_USAGE',
      `Cannot write --output ${output}: ${(error as Error).message}`
    );
  }
}

/** Refuse an output that would replace one of the inputs (also through a link or case). */
export function assertOutputIsNotInput(
  output: string,
  inputs: (string | null | undefined)[]
) {
  let target: fs.Stats | undefined;
  try {
    target = fs.statSync(output);
  } catch {}
  for (const input of inputs) {
    if (!input) continue;
    let same = path.resolve(input) === path.resolve(output);
    if (!same && target)
      try {
        const stat = fs.statSync(input);
        same = stat.ino === target.ino && stat.dev === target.dev;
      } catch {}
    if (same)
      throw new ProfilerError(
        'E_OUTPUT_CONFLICT',
        `--output ${output} would overwrite the input ${input}; choose another --output`
      );
  }
}

/** An `analyze --output <file>.json` report, or an `analyze --json` envelope. */
export function readReport(file: string): AnalysisReport {
  const hint =
    'compare needs reports written by `analyze --output <file>.json` (or `analyze --json` output)';
  if (!fs.existsSync(file))
    throw new ProfilerError('E_USAGE', `Report not found: ${file}; ${hint}`);
  requireFile(file, 'Report');
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ProfilerError('E_USAGE', `${file} is not JSON; ${hint}`);
  }
  if (parsed?.ok === false)
    throw new ProfilerError(
      'E_USAGE',
      `${file} holds a failed command (${parsed.error?.code}: ${parsed.error?.message}), not an analyze report`
    );
  const report = parsed?.command === 'analyze' ? parsed.result : parsed;
  const valid =
    report?.version === 1 &&
    report.session &&
    typeof report.session === 'object' &&
    typeof report.quality?.jsIntervalMs?.median === 'number' &&
    ['windowMs', 'busyMs', 'gcMs'].every(
      (key) => typeof report.js?.[key] === 'number'
    ) &&
    Array.isArray(report.js.topFunctions) &&
    Array.isArray(report.js.longTasks);
  if (!valid)
    throw new ProfilerError(
      'E_USAGE',
      `${file} is not an analyze report; ${hint}`
    );
  return report;
}
