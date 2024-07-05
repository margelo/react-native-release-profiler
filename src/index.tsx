import { NativeModules, Platform } from 'react-native';

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

export function stopProfiling(
  saveToDownloads = false,
  _fileName = ''
): Promise<string> {
  return ReleaseProfiler.stopProfiling(saveToDownloads);
}
