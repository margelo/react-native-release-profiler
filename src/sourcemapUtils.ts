// Copy of https://github.com/react-native-community/cli/blob/13.x/packages/cli-hermes/src/profileHermes/metroBundleOptions.ts as `cli-hermes` was recently removed from React Native Community CLI

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SourceMap } from 'hermes-profile-transformer';
import type { MetroBundleOptions } from './getMetroBundleOptions';

type Config = any;

function getTempFilePath(filename: string) {
  return path.join(os.tmpdir(), filename);
}

function writeJsonSync(targetPath: string, data: any) {
  let json;
  try {
    json = JSON.stringify(data);
  } catch (e) {
    throw new Error(
      `Failed to serialize data to json before writing to ${targetPath}`,
      e as Error
    );
  }

  try {
    fs.writeFileSync(targetPath, json, 'utf-8');
  } catch (e) {
    throw new Error(`Failed to write json to ${targetPath}`, e as Error);
  }
}

async function getSourcemapFromServer(
  port: string,
  { platform, dev, minify, host }: MetroBundleOptions
): Promise<SourceMap | undefined> {
  console.log('Getting source maps from Metro packager server');

  const requestURL = `http://${host}:${port}/index.map?platform=${platform}&dev=${dev}&minify=${minify}`;
  console.log(`Downloading from ${requestURL}`);
  try {
    // @ts-ignore
    const { data } = await fetch(requestURL);
    return data as SourceMap;
  } catch (e) {
    console.log(`Failed to fetch source map from "${requestURL}"`);
    return undefined;
  }
}

/**
 * Generate a sourcemap by fetching it from a running metro server
 */
export async function generateSourcemap(
  port: string,
  bundleOptions: MetroBundleOptions
): Promise<string | undefined> {
  // Fetch the source map to a temp directory
  const sourceMapPath = getTempFilePath('index.map');
  const sourceMapResult = await getSourcemapFromServer(port, bundleOptions);

  if (sourceMapResult) {
    console.log('Using source maps from Metro packager server');
    writeJsonSync(sourceMapPath, sourceMapResult);
    console.log(
      `Successfully obtained the source map and stored it in ${sourceMapPath}`
    );
    return sourceMapPath;
  } else {
    console.log('Error: Cannot obtain source maps from Metro packager server');
    return undefined;
  }
}

/**
 *
 * @param ctx
 */
export async function findSourcemap(
  ctx: Config,
  port: string,
  bundleOptions: MetroBundleOptions
): Promise<string | undefined> {
  const intermediateBuildPath = path.join(
    ctx.root,
    'android',
    'app',
    'build',
    'intermediates',
    'sourcemaps',
    'react',
    'debug',
    'index.android.bundle.packager.map'
  );

  const generatedBuildPath = path.join(
    ctx.root,
    'android',
    'app',
    'build',
    'generated',
    'sourcemaps',
    'react',
    'debug',
    'index.android.bundle.map'
  );

  if (fs.existsSync(generatedBuildPath)) {
    console.log(`Getting the source map from ${generateSourcemap}`);
    return generatedBuildPath;
  } else if (fs.existsSync(intermediateBuildPath)) {
    console.log(`Getting the source map from ${intermediateBuildPath}`);
    return intermediateBuildPath;
  } else {
    return generateSourcemap(port, bundleOptions);
  }
}
