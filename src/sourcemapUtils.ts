// Copy of https://github.com/react-native-community/cli/blob/13.x/packages/cli-hermes/src/profileHermes/metroBundleOptions.ts as `cli-hermes` was recently removed from React Native Community CLI

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SourceMap } from '@margelo/hermes-profile-transformer';
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

/**
 * Returns the Metro bundle entry point path derived from the project's
 * package.json `main` field.
 *
 * Expo SDK 55+ (and any project using expo-router) sets `"main":
 * "expo-router/entry"` instead of the default `"index"`. Metro serves the
 * source map for that bundle at `/node_modules/expo-router/entry.map`, not
 * `/index.map`. When the wrong URL is used Metro responds with an
 * `UnableToResolveError` JSON object, which then crashes the source-map
 * consumer because the expected `sources` array is missing.
 */
function getMetroEntryPoint(): string {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const main: string | undefined = pkg.main;
    if (main && main !== 'index' && main !== './index') {
      // Bare relative path: strip leading "./"
      if (main.startsWith('./')) {
        return main.slice(2);
      }
      // Package-style path (e.g. "expo-router/entry"): Metro serves it
      // under node_modules/
      return `node_modules/${main}`;
    }
  } catch {
    // Fall through to the default entry point.
  }
  return 'index';
}

async function getSourcemapFromServer(
  port: string,
  { platform, dev, minify, host }: MetroBundleOptions
): Promise<SourceMap | undefined> {
  console.log('Getting source maps from Metro packager server');

  const entryPoint = getMetroEntryPoint();
  const requestURL = `http://${host}:${port}/${entryPoint}.map?platform=${platform}&dev=${dev}&minify=${minify}`;
  console.log(`Downloading from ${requestURL}`);
  try {
    const res = await fetch(requestURL);
    const data = await res.json();
    if (typeof data !== 'object' || !Array.isArray((data as any).sources)) {
      console.log(
        `Failed to fetch source map from "${requestURL}", unexpected response format.`
      );
      if (data && (data as any).type && (data as any).message) {
        console.log(`Metro error: ${(data as any).message}`);
      }
      return undefined;
    }

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
