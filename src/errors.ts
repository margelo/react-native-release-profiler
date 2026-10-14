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
  | 'E_OUTPUT_CONFLICT';

export class ProfilerError extends Error {
  constructor(readonly code: ProfilerErrorCode, message: string) {
    super(message);
    this.name = 'ProfilerError';
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof ProfilerError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  // Commander usage errors (unknown command, missing argument, ...).
  return typeof code === 'string' && code.startsWith('commander.')
    ? 'E_USAGE'
    : 'E_UNKNOWN';
}
