import { execFileSync } from 'child_process';
import { resolveIOSDevice } from './iosDevice';

/** Copy one profile from the cache directory used by ReleaseProfiler.mm. */
export function createIOSProfileCopy(
  device: string | undefined,
  bundleId: string | undefined,
  filename: string | undefined,
  fromDownload: Boolean | undefined
): (destination: string) => void {
  if (process.platform !== 'darwin') {
    throw new Error(
      'iOS device downloads require macOS and Xcode with devicectl.'
    );
  }
  if (!bundleId) {
    throw new Error(
      'Provide --appId with the installed iOS app bundle identifier.'
    );
  }
  if (
    !filename ||
    filename.includes('/') ||
    filename.includes('\\') ||
    !filename.endsWith('.cpuprofile')
  ) {
    throw new Error(
      'Provide --filename with the .cpuprofile basename returned by stopProfiling(), not its full path.'
    );
  }
  if (fromDownload) {
    throw new Error(
      '--fromDownload is Android-only. iOS profiles are stored in Library/Caches.'
    );
  }

  const selectedDevice = resolveIOSDevice(device);

  return (destination) => {
    // Separate arguments preserve spaces and avoid interpreting shell metacharacters.
    execFileSync(
      'xcrun',
      [
        'devicectl',
        'device',
        'copy',
        'from',
        '--device',
        selectedDevice,
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        bundleId,
        '--source',
        `Library/Caches/${filename}`,
        '--destination',
        destination,
      ],
      { stdio: 'inherit' }
    );
  };
}
