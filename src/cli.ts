#!/usr/bin/env node
import { logger, CLIError } from '@react-native-community/cli-tools';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import transformer from '@margelo/hermes-profile-transformer';
import { getMetroBundleOptions } from './getMetroBundleOptions';
import { generateSourcemap, findSourcemap } from './sourcemapUtils';
import getConfig from './getConfig';
import { createIOSProfileCopy } from './iosProfile';

// Most of the file is just a copy of https://github.com/react-native-community/cli/blob/main/packages/cli-hermes/src/profileHermes/downloadProfile.ts

/**
 * Get the last modified hermes profile
 * @param packageNameWithSuffix
 */
function getLatestFile(packageNameWithSuffix: string): string {
  try {
    const file =
      execSync(`adb shell run-as ${packageNameWithSuffix} ls cache/ -tp | grep -v /$ | grep -E '.cpuprofile' | head -1
        `);
    return file.toString().trim();
  } catch (e) {
    throw e;
  }
}

function execSyncWithLog(command: string) {
  logger.debug(`${command}`);
  return execSync(command);
}

/**
 * A wrapper that converts an object to JSON with 4 spaces for indentation.
 *
 * @param obj Any object that can be represented as JSON
 * @returns A JSON string
 */
function jsonStringify(obj: any) {
  return JSON.stringify(obj, undefined, 4);
}

function getLatestFileFromDownloads() {
  try {
    const file = execSync(
      `adb shell ls "/sdcard/Download" -tp | grep -v /$ | grep -E '.cpuprofile' | head -1`
    );
    return file.toString().trim();
  } catch (e) {
    throw e;
  }
}

function maybeAddLineAndColumn(path: string): void {
  const profile = fs.readFileSync(path, 'utf8');
  const profileJson = JSON.parse(profile);
  const stackFrames = profileJson.stackFrames;
  if (stackFrames !== undefined) {
    for (const key of Object.keys(stackFrames)) {
      const stackFrame = stackFrames[key];
      if (stackFrame.funcVirtAddr && stackFrame.offset) {
        stackFrame.line = `${1}`;
        stackFrame.column = `${
          parseInt(stackFrame.funcVirtAddr) + parseInt(stackFrame.offset) + 1
        }`;
        delete stackFrame.funcVirtAddr;
        delete stackFrame.offset;
      }
    }
    fs.writeFileSync(path, JSON.stringify(profileJson));
  }
}

/**
 * Pull and convert a Hermes tracing profile to Chrome tracing profile
 * @param ctx
 * @param dstPath
 * @param fileName
 * @param sourceMapPath
 * @param raw
 * @param generateSourceMap
 * @param appId
 * @param appIdSuffix
 */
export async function downloadProfile(
  local: string | undefined,
  fromDownload: Boolean | undefined,
  dstPath: string,
  filename?: string,
  sourcemapPath?: string,
  raw?: boolean,
  shouldGenerateSourcemap?: boolean,
  port: string = '8081',
  appId?: string,
  appIdSuffix?: string,
  platform: string = 'android',
  device?: string
) {
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error('--platform must be android or ios.');
  }
  const copyIOSProfile =
    platform === 'ios' && !local
      ? createIOSProfileCopy(
          device,
          appId ? [appId, appIdSuffix].filter(Boolean).join('.') : undefined,
          filename,
          fromDownload
        )
      : undefined;
  // iOS uses an explicit bundle identifier and does not need Android project config.
  const ctx = platform === 'ios' ? null : await getConfig();
  let temporaryDirectory: string | undefined;

  try {
    const androidProject = ctx?.project.android;
    const packageNameWithSuffix = [
      appId || androidProject?.packageName,
      appIdSuffix,
    ]
      .filter(Boolean)
      .join('.');

    if (platform === 'android' && !packageNameWithSuffix && !local) {
      throw new Error(
        "Failed to retrieve the package name from the project's Android manifest file. Please provide the package name with the --appId flag."
      );
    }

    // If file name is not specified, pull the latest file from device
    let file =
      filename ||
      (local ? path.basename(local) : undefined) ||
      (fromDownload
        ? getLatestFileFromDownloads()
        : getLatestFile(packageNameWithSuffix));
    if (!file) {
      throw new CLIError(
        'There is no file in the cache/ directory. Did you record a profile from the developer menu?'
      );
    }

    logger.info(`File to be pulled: ${file}`);

    // If destination path is not specified, pull to the current directory
    dstPath = dstPath || ctx?.root || '.';

    logger.debug('Internal commands run to pull the file:');

    // If --raw, pull the hermes profile to dstPath
    if (raw) {
      if (local) {
        const destination = path.resolve(dstPath, file);
        if (path.resolve(local) !== destination) {
          fs.copyFileSync(local, destination);
        }
      } else if (copyIOSProfile) {
        copyIOSProfile(path.join(dstPath, file));
      } else if (fromDownload) {
        execSyncWithLog(
          `adb shell cat /sdcard/Download/${file} > ${dstPath}/${file}`
        );
      } else {
        execSyncWithLog(
          `adb shell run-as ${packageNameWithSuffix} cat cache/${file} > ${dstPath}/${file}`
        );
      }

      maybeAddLineAndColumn(`${dstPath}/${file}`);
      logger.success(`Successfully pulled the file to ${dstPath}/${file}`);
    }

    // Else: transform the profile to Chrome format and pull it to dstPath
    else {
      temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'release-profiler-')
      );
      const tempFilePath = path.join(temporaryDirectory, path.basename(file));

      if (local) {
        fs.copyFileSync(local, tempFilePath);
      } else if (copyIOSProfile) {
        copyIOSProfile(tempFilePath);
      } else if (fromDownload) {
        execSyncWithLog(
          `adb shell cat /sdcard/Download/${file} > ${tempFilePath}`
        );
      } else {
        execSyncWithLog(
          `adb shell run-as ${packageNameWithSuffix} cat cache/${file} > ${tempFilePath}`
        );
      }
      maybeAddLineAndColumn(tempFilePath);
      const bundleOptions = getMetroBundleOptions(tempFilePath, 'localhost');
      if (platform === 'ios') {
        bundleOptions.platform = 'ios';
      }

      // If path to source map is not given
      if (!sourcemapPath) {
        // Get or generate the source map
        if (shouldGenerateSourcemap || platform === 'ios') {
          sourcemapPath = await generateSourcemap(port, bundleOptions);
        } else {
          sourcemapPath = await findSourcemap(ctx, port, bundleOptions);
        }

        // Run without source map
        if (!sourcemapPath) {
          logger.warn(
            'Cannot find source maps, running the transformer without it'
          );
          logger.info(
            platform === 'ios'
              ? 'Provide --sourcemap-path with the source map from the profiled iOS build.'
              : 'Instructions on how to get source maps: set `bundleInDebug: true` in your app/build.gradle file, inside the `project.ext.react` map.'
          );
        }
      }

      // Run transformer tool to convert from Hermes to Chrome format
      const events = await transformer(
        tempFilePath,
        sourcemapPath,
        'index.bundle'
      );

      const transformedFilePath = `${dstPath}/${path.basename(
        file,
        '.cpuprofile'
      )}-converted.json`;

      // Convert to JSON in chunks because JSON.stringify() will fail for large
      // arrays with the error "RangeError: Invalid string length"
      const out = events.map(jsonStringify).join(',');

      fs.writeFileSync(transformedFilePath, '[' + out + ']', 'utf-8');
      logger.success(
        `Successfully converted to Chrome tracing format and pulled the file to ${transformedFilePath}`
      );
    }
  } finally {
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function getFilename(path?: string) {
  if (path == null) {
    return null;
  }
  const nodes = path.split('/');
  const res = nodes[nodes.length - 1];
  return res;
}

if (require.main === module) {
  const { program } = require('commander');

  program
    .option('--platform <string>', 'Device platform: android or ios', 'android')
    .option('--device <string>', 'iOS device identifier or name from devicectl')
    .option(
      '--filename <string>',
      'Profile basename (required for iOS device downloads)'
    )
    .option('--sourcemap-path <string>')
    .option('--generate-sourcemap')
    .option('--port <number>')
    .option('--appId <string>')
    .option('--appIdSuffix <string>')
    .option('--fromDownload')
    .option('--raw')
    .option('--local <string>');

  program.parse();

  const options = program.opts();
  const dstPath = '.';
  downloadProfile(
    options.local,
    options.fromDownload,
    dstPath,
    options.filename || getFilename(options.local),
    options.sourcemapPath,
    options.raw,
    options.generateSourcemap,
    options.port,
    options.appId,
    options.appIdSuffix,
    options.platform,
    options.device
  ).catch((error: Error) => {
    logger.error(error.message);
    process.exitCode = 1;
  });
}
