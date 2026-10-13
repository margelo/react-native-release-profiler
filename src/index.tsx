import { NativeModules, Platform, PermissionsAndroid } from 'react-native';

const LINKING_ERROR =
  `The package 'react-native-release-profiler' doesn't seem to be linked. Make sure: \n\n` +
  Platform.select({ ios: "- You have run 'pod install'\n", default: '' }) +
  '- You rebuilt the app after installing the package\n' +
  '- You are not using Expo Go\n';

const ReleaseProfiler = NativeModules.ReleaseProfiler
  ? NativeModules.ReleaseProfiler
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      }
    );

export function startProfiling(): boolean {
  return ReleaseProfiler.startProfiling();
}

export async function stopProfiling(
  saveToDownloads = false,
  _fileName = ''
): Promise<string> {
  if (saveToDownloads && Platform.OS === 'android' && Platform.Version < 29) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE!
    );
    if (!result) {
      throw new Error(
        'WRITE_EXTERNAL_STORAGE permission is required to save to downloads.'
      );
    }
  }
  return await ReleaseProfiler.stopProfiling(saveToDownloads);
}

export interface ProfilingSessionOptions {
  /** Requested native recording duration; Android may clamp this value. Default: 30000. */
  durationMs?: number;
  /** Requested native CPU samples per second. Default: 100. */
  samplingFrequencyHz?: number;
  /** Native trace buffer size. Default: 8192 KB. */
  bufferSizeKb?: number;
  /** Maximum wait for native results after stop. Default: 120000 ms. */
  resultTimeoutMs?: number;
}

export interface ProfilingSessionArtifacts {
  sessionId: string;
  manifestPath: string;
  hermesProfilePath: string;
  nativeProfilePath: string | null;
  nativeStatus: 'success' | 'error' | 'timeout';
  nativeError: string | null;
  /** android.os.ProfilingResult error code (0 on success), or null on timeout. */
  nativeErrorCode: number | null;
  downloadUris?: string[];
}

export interface ProfilingSession {
  sessionId: string;
  /** Stops Hermes immediately, requests native stop, then waits for native output.
   * Export to Downloads to retrieve artifacts from a non-debuggable app via ADB.
   */
  stop(saveToDownloads?: boolean): Promise<ProfilingSessionArtifacts>;
}

/** Android 15+ only. Resolution means requested, not that native sampling is ready.
 * System rate limits and asynchronous errors are reported in stop() artifacts.
 * Enables Hermes and adopts a native recording started by NativeProfiling.start()
 * without restarting native sampling. Options are ignored when adopting that session.
 * If no native recording exists, starts both collectors.
 */
export async function startProfilingSession(
  options: ProfilingSessionOptions = {}
): Promise<ProfilingSession> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 35) {
    throw new Error('Native sampling requires Android 15 (API 35) or newer.');
  }
  const sessionId: string = await ReleaseProfiler.startProfilingSession(
    options
  );
  let stopping: Promise<ProfilingSessionArtifacts> | undefined;
  return {
    sessionId,
    stop(saveToDownloads = false) {
      if (!stopping) {
        stopping = ReleaseProfiler.stopProfilingSession(
          sessionId,
          saveToDownloads
        ) as Promise<ProfilingSessionArtifacts>;
      }
      return stopping;
    },
  };
}
