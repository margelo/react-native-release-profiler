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

/** Like native rejections, carries a machine-readable `code`. */
function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function startProfiling(): boolean {
  return ReleaseProfiler.startProfiling();
}

/**
 * Stops `startProfiling()` and resolves with the profile's path in the app's cache.
 * On Android, `saveToDownloads` also copies it to Download/ under the same file name:
 * `react-native-release-profiler --fromDownload --filename <that file name>`.
 * Rejects with code `E_NOT_STARTED` when `startProfiling()` was not called.
 */
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
  /** App-private paths; on a release build only the app (not adb) can read them. */
  manifestPath: string;
  hermesProfilePath: string;
  nativeProfilePath: string | null;
  nativeStatus: 'success' | 'error' | 'timeout';
  nativeError: string | null;
  /** android.os.ProfilingResult error code (0 on success), or null on timeout. */
  nativeErrorCode: number | null;
  downloadUris?: string[];
  /**
   * True after `stop(true)` exported copies to Download/release-profiler/<sessionId>/.
   * False: the files are only in app-private storage, which the CLI cannot pull from a
   * release (non-debuggable) build. The 5 most recent sessions are kept there.
   */
  savedToDownloads: boolean;
  /** See ProfilingSession. */
  adopted: boolean;
  nativeEndedBeforeAdoption: boolean;
}

interface NativeStartResult {
  sessionId: string;
  adopted: boolean;
  nativeEndedBeforeAdoption: boolean;
}

export interface ProfilingSession {
  sessionId: string;
  /**
   * True when this session adopted the native startup recording from
   * NativeProfiling.start(); that call's options stay in effect.
   */
  adopted: boolean;
  /**
   * True when the adopted native recording had already ended (or reached its duration)
   * before JS sampling started, so it holds no native samples for this session. The startup
   * data is still exported; stop and start a new session to record native stacks now.
   */
  nativeEndedBeforeAdoption: boolean;
  /** Stops Hermes immediately, requests native stop, then waits for native output.
   * Export to Downloads to retrieve artifacts from a non-debuggable app via ADB.
   */
  stop(saveToDownloads?: boolean): Promise<ProfilingSessionArtifacts>;
}

/** Android 15+ only; otherwise rejects with code `E_UNSUPPORTED`.
 * Resolution means requested, not that native sampling is ready.
 * System rate limits and asynchronous errors are reported in stop() artifacts.
 * Enables Hermes and adopts a native recording started by NativeProfiling.start()
 * without restarting native sampling. Options are validated but not applied when
 * adopting that session. If no native recording exists, starts both collectors.
 */
export async function startProfilingSession(
  options: ProfilingSessionOptions = {}
): Promise<ProfilingSession> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 35) {
    throw codedError(
      'E_UNSUPPORTED',
      'Native sampling requires Android 15 (API 35) or newer.'
    );
  }
  const started: NativeStartResult =
    await ReleaseProfiler.startProfilingSession(options);
  const { sessionId, adopted, nativeEndedBeforeAdoption } = started;
  if (nativeEndedBeforeAdoption) {
    console.warn(
      'startProfilingSession(): the adopted native startup recording had already ended, so ' +
        'no native samples overlap this session (the startup samples are still exported). ' +
        'Stop it and start a new session to record native stacks now.'
    );
  } else if (
    adopted &&
    Object.values(options).some((value) => value !== undefined)
  ) {
    console.warn(
      'startProfilingSession(): adopted the native startup recording; its options stay in ' +
        'effect and the options passed here were not applied.'
    );
  }
  let stopping: Promise<ProfilingSessionArtifacts> | undefined;
  return {
    sessionId,
    adopted,
    nativeEndedBeforeAdoption,
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
