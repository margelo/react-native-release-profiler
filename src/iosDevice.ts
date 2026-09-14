import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@react-native-community/cli-tools';

interface Device {
  identifier?: string;
  hardwareProperties?: { platform?: string; reality?: string };
  connectionProperties?: { pairingState?: string; tunnelState?: string };
  deviceProperties?: { name?: string };
}

/** Resolve a single available physical iOS device without guessing between peers. */
export function resolveIOSDevice(device?: string): string {
  if (device) {
    return device;
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'release-profiler-devices-')
  );
  try {
    const output = path.join(directory, 'devices.json');
    execFileSync(
      'xcrun',
      ['devicectl', 'list', 'devices', '--json-output', output],
      { stdio: 'pipe' }
    );
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (!Array.isArray(result?.result?.devices)) {
      throw new Error(
        'Unexpected devicectl device list. Provide --device explicitly.'
      );
    }
    const candidates = (result.result.devices as (Device | null)[]).filter(
      (candidate): candidate is Device & { identifier: string } =>
        typeof candidate?.identifier === 'string' &&
        candidate.identifier.length > 0 &&
        candidate.hardwareProperties?.platform === 'iOS' &&
        candidate.hardwareProperties.reality !== 'simulated' &&
        candidate.connectionProperties?.pairingState === 'paired' &&
        ['connected', 'disconnected'].includes(
          candidate.connectionProperties.tunnelState ?? ''
        )
    );
    if (candidates.length === 0) {
      throw new Error(
        'No available paired iOS device. Connect and trust your device, or provide --device explicitly.'
      );
    }
    if (candidates.length > 1) {
      const choices = candidates
        .map(
          (candidate) =>
            `${candidate.deviceProperties?.name ?? 'iOS device'} (${
              candidate.identifier
            })`
        )
        .join(', ');
      throw new Error(
        `Multiple iOS devices are available. Provide --device to choose one: ${choices}`
      );
    }
    const selected = candidates[0]!;
    logger.info(
      `Using iOS device: ${
        selected.deviceProperties?.name ?? selected.identifier
      } (${selected.identifier})`
    );
    return selected.identifier;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
