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
