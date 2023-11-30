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

export function startProfiling(): Boolean {
  if (Platform.OS !== 'android') {
    return false;
  }
  return ReleaseProfiler.startProfiling();
}

export function stopProfiling(): Promise<void> {
  if (Platform.OS !== 'android') {
    return Promise.resolve();
  }
  return ReleaseProfiler.stopProfiling();
}
