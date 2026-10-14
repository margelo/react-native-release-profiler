import fs from 'fs';

/** Stable, machine-readable failure codes for the CLI (`--json` prints `error.code`). */
export type ProfilerErrorCode =
  | 'E_USAGE'
  | 'E_ADB'
  | 'E_NO_SESSIONS'
  | 'E_BAD_SESSION_ID'
  | 'E_SESSION_MANIFEST'
  | 'E_NATIVE_MISSING'
  | 'E_NO_NATIVE_SAMPLES'
  | 'E_WRONG_NATIVE_TRACE'
  | 'E_CLOCK'
  | 'E_SOURCEMAP_MISMATCH'
  | 'E_SOURCEMAP_UNRESOLVED'
  | 'E_HERMES_PROFILE'
  | 'E_TRACE_FORMAT'
  | 'E_OUTPUT_CONFLICT'
  | 'E_NO_PROFILE'
  | 'E_DOCTOR_FAILED';

export class ProfilerError extends Error {
  constructor(readonly code: ProfilerErrorCode, message: string) {
    super(message);
    this.name = 'ProfilerError';
  }
}

/** Unexpected failures (bugs) only; anything a user can fix has a code above. */
export function errorCode(error: unknown): string {
  if (error instanceof ProfilerError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  // Commander usage errors (unknown command, missing argument, ...).
  return typeof code === 'string' && code.startsWith('commander.')
    ? 'E_USAGE'
    : 'E_UNKNOWN';
}

/** Read an input file (a session artifact, a report, ...), failing with `code` and a
 * remedy instead of a raw fs error such as ENOENT or EISDIR. */
export function readInputFile(
  file: string,
  code: ProfilerErrorCode,
  what: string,
  remedy: string
): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    throw new ProfilerError(
      code,
      `Cannot read ${what} ${file}: ${(error as Error).message}. ${remedy}`
    );
  }
}
