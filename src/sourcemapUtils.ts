// Copy of https://github.com/react-native-community/cli/blob/13.x/packages/cli-hermes/src/profileHermes/metroBundleOptions.ts as `cli-hermes` was recently removed from React Native Community CLI

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SourceMap } from '@margelo/hermes-profile-transformer';
import type { MetroBundleOptions } from './getMetroBundleOptions';
import type { HermesProfile } from './mergeProfiles';
import { assertSourceMapMatchesProfile } from './symbolicate';

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
    const res = await fetch(requestURL);
    const data = await res.json();
    if (typeof data !== 'object') {
      console.log(
        `Failed to fetch source map from "${requestURL}", unexpected response format.`
      );
      return undefined;
    }

    return data as SourceMap;
  } catch {
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

/** Release builds run Hermes bytecode: frames carry bytecode addresses rather than source
 * positions (debug builds may still include a few precompiled bytecode frames). */
export function isBytecodeProfile(profile: HermesProfile): boolean {
  const frames = Object.values(profile.stackFrames ?? {}).filter(
    (frame) => frame.category === 'JavaScript'
  );
  const bytecode = frames.filter((f) => f.funcVirtAddr !== undefined).length;
  return bytecode > frames.length - bytecode;
}

/** Whether the map at `file` belongs to the build that recorded `profile`. */
export function sourceMapFits(
  file: string,
  profile: HermesProfile
): { ok: boolean; reason?: string } {
  let map: { x_hermes_function_offsets?: Record<string, number[]> };
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `unreadable (${(error as Error).message})` };
  }
  try {
    assertSourceMapMatchesProfile(map, profile);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const hasOffsets = Object.values(map.x_hermes_function_offsets ?? {}).some(
    (offsets) => offsets.length
  );
  // Release profiles need the composed Hermes map (it lists function offsets); packager and
  // dev-server maps describe a different bundle and would resolve frames to the wrong code.
  return isBytecodeProfile(profile) && !hasOffsets
    ? {
        ok: false,
        reason:
          'not the composed Hermes source map of a release build (no x_hermes_function_offsets)',
      }
    : { ok: true };
}

/** The legacy transformer only reads flat maps; Metro's dev server serves sectioned (index) maps. */
export async function flattenSourceMap(file: string): Promise<string> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.sections)) return file;
  const { SourceMapConsumer, SourceMapGenerator } = require('source-map');
  const consumer = await new SourceMapConsumer(raw);
  try {
    // Copy mappings only: sections may reference sources without content (e.g. assets).
    const generator = new SourceMapGenerator({ file: raw.file });
    consumer.eachMapping((mapping: any) => {
      if (mapping.source == null || mapping.originalLine == null) return;
      generator.addMapping({
        generated: {
          line: mapping.generatedLine,
          column: mapping.generatedColumn,
        },
        original: {
          line: mapping.originalLine,
          column: mapping.originalColumn,
        },
        source: mapping.source,
        name: mapping.name ?? undefined,
      });
    });
    const flat = getTempFilePath(`flat-${path.basename(file)}`);
    writeJsonSync(flat, generator.toJSON());
    return flat;
  } finally {
    consumer.destroy();
  }
}

/**
 * Find the source map for `profile`: the composed release map first, then debug maps, each
 * checked against the profile. Release (bytecode) profiles never use the Metro dev server,
 * whose maps describe a different bundle.
 */
export async function findSourcemap(
  ctx: Config,
  port: string,
  bundleOptions: MetroBundleOptions,
  profile?: HermesProfile
): Promise<string | undefined> {
  const root = ctx?.root ?? process.cwd();
  const candidates = ['release', 'debug'].flatMap((variant) => [
    path.join(
      root,
      'android',
      'app',
      'build',
      'generated',
      'sourcemaps',
      'react',
      variant,
      'index.android.bundle.map'
    ),
    path.join(
      root,
      'android',
      'app',
      'build',
      'intermediates',
      'sourcemaps',
      'react',
      variant,
      'index.android.bundle.packager.map'
    ),
  ]);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (profile) {
      const fit = sourceMapFits(candidate, profile);
      if (!fit.ok) {
        console.log(`Skipping source map ${candidate}: ${fit.reason}`);
        continue;
      }
    }
    console.log(`Getting the source map from ${candidate}`);
    return candidate;
  }
  if (profile && isBytecodeProfile(profile)) {
    console.log(
      'No source map matching this release profile was found. Pass --sourcemap-path with the composed map of the exact build (android/app/build/generated/sourcemaps/react/release/index.android.bundle.map).'
    );
    return undefined;
  }
  return generateSourcemap(port, bundleOptions);
}
