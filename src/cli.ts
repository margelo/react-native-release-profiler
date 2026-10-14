#!/usr/bin/env node
import { logger, CLIError } from '@react-native-community/cli-tools';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import transformer from '@margelo/hermes-profile-transformer';
import { getMetroBundleOptions } from './getMetroBundleOptions';
import {
  generateSourcemap,
  findSourcemap,
  flattenSourceMap,
  isBytecodeProfile,
  sourceMapFits,
} from './sourcemapUtils';
import getConfig from './getConfig';
import { mergeSession, type MergeFormat } from './mergeProfiles';
import { pullMerge, pullSession } from './pullMerge';
import { analyze, renderAnalysis, type AnalysisReport } from './analyze';
import { compareReports, renderComparison } from './compare';
import { renderDoctor, runDoctor } from './doctor';
import { errorCode, ProfilerError } from './errors';

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
  appIdSuffix?: string
) {
  let ctx = local && sourcemapPath ? null : await getConfig();

  try {
    const androidProject = ctx?.project.android;
    const packageNameWithSuffix = [
      appId || androidProject?.packageName,
      appIdSuffix,
    ]
      .filter(Boolean)
      .join('.');

    if (!packageNameWithSuffix && !local) {
      throw new Error(
        "Failed to retrieve the package name from the project's Android manifest file. Please provide the package name with the --appId flag."
      );
    }

    // If file name is not specified, pull the latest file from device
    let file =
      filename ||
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
      if (fromDownload) {
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
      const osTmpDir = os.tmpdir();
      const tempFilePath = path.join(osTmpDir, file);

      if (local) {
        fs.copyFileSync(local, tempFilePath);
      } else if (fromDownload) {
        execSyncWithLog(
          `adb shell cat /sdcard/Download/${file} > ${tempFilePath}`
        );
      } else {
        execSyncWithLog(
          `adb shell run-as ${packageNameWithSuffix} cat cache/${file} > ${tempFilePath}`
        );
      }
      // Read before maybeAddLineAndColumn() rewrites bytecode addresses as positions.
      const profile = JSON.parse(fs.readFileSync(tempFilePath, 'utf8'));
      maybeAddLineAndColumn(tempFilePath);
      const bundleOptions = getMetroBundleOptions(tempFilePath, 'localhost');

      // A map from another build "resolves" frames to the wrong code; refuse it.
      const checkMap = (map: string) => {
        const fit = sourceMapFits(map, profile);
        if (!fit.ok)
          throw new ProfilerError(
            'E_SOURCEMAP_MISMATCH',
            `Source map ${map} does not match this profile: ${fit.reason}`
          );
      };

      if (sourcemapPath) checkMap(sourcemapPath);
      else {
        // Get or generate the source map
        if (shouldGenerateSourcemap) {
          sourcemapPath = await generateSourcemap(port, bundleOptions);
          if (sourcemapPath) checkMap(sourcemapPath);
        } else {
          sourcemapPath = await findSourcemap(
            ctx,
            port,
            bundleOptions,
            profile
          );
        }

        // Run without source map
        if (!sourcemapPath) {
          logger.warn(
            'Cannot find source maps, running the transformer without it'
          );
          logger.info(
            isBytecodeProfile(profile)
              ? 'Function names are kept but source files and lines will be missing. Pass --sourcemap-path with the composed map of the exact release build (android/app/build/generated/sourcemaps/react/release/index.android.bundle.map).'
              : 'Instructions on how to get source maps: set `bundleInDebug: true` in your app/build.gradle file, inside the `project.ext.react` map.'
          );
        }
      }

      // Run transformer tool to convert from Hermes to Chrome format
      if (sourcemapPath) sourcemapPath = await flattenSourceMap(sourcemapPath);
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
  } catch (e) {
    throw e;
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

// `--json`: print exactly one JSON object to stdout and nothing else, for agents and scripts.
const jsonMode = process.argv.includes('--json');
if (jsonMode) logger.disable();

function emit(command: string, result: unknown, text?: string) {
  if (jsonMode)
    process.stdout.write(JSON.stringify({ ok: true, command, result }) + '\n');
  else if (text) process.stdout.write(text);
}

/** Report what was actually captured, not only what was requested. */
function mergeWarnings(
  result: Awaited<ReturnType<typeof mergeSession>>
): string[] {
  const warnings: string[] = [];
  const requested = result.requestedFrequencyHz;
  if (
    result.nativeFrequencyHz !== undefined &&
    requested !== undefined &&
    requested !== result.nativeFrequencyHz
  )
    warnings.push(
      `Android clamped native sampling to ${result.nativeFrequencyHz} Hz (requested ${requested} Hz)`
    );
  if (!result.overlappingNativeSamples)
    warnings.push(
      'No native samples overlap the JS samples: native sampling ended before JS sampling started (e.g. a startup recording adopted late)'
    );
  warnings.push(...result.nativeWarnings);
  if (result.nativeRecordsLost)
    warnings.push(
      `${result.nativeRecordsLost} native sample records were lost by the kernel buffer; native counts are a lower bound`
    );
  const skipped = Object.values(result.skippedSamples).reduce(
    (a, b) => a + b,
    0
  );
  if (skipped)
    warnings.push(
      `${skipped} native samples were unusable and skipped: ${JSON.stringify(
        result.skippedSamples
      )}`
    );
  if (result.unmappedFrames)
    warnings.push(`${result.unmappedFrames} JS frames could not be mapped`);
  return warnings;
}

function reportMerge(
  command: string,
  result: Awaited<ReturnType<typeof mergeSession>>
) {
  const warnings = mergeWarnings(result);
  // `warnings` already includes nativeWarnings.
  if (jsonMode)
    return emit(command, { ...result, nativeWarnings: undefined, warnings });
  logger.success(
    `Merged ${result.nativeSamples} native and ${result.samples} JS samples into ${result.output}; ${result.symbolicatedFrames} symbolicated frames`
  );
  if (
    result.nativeFrequencyHz !== undefined &&
    !warnings[0]?.startsWith('Android clamped')
  )
    logger.info(`Native sampling ran at ${result.nativeFrequencyHz} Hz`);
  warnings.forEach((warning) => logger.warn(warning));
}

const defaultOutput = (format: MergeFormat) =>
  format === 'simpleperf'
    ? 'merged.trace'
    : format === 'folded'
    ? 'merged.folded.txt'
    : 'merged.perfetto-trace';

const requireSourceMap = (
  options: { sourcemapPath?: string },
  command: string
) => {
  if (!options.sourcemapPath)
    throw new ProfilerError(
      'E_USAGE',
      `${command} requires --sourcemap-path from the exact release build`
    );
  return options.sourcemapPath;
};

const { program, Option } = require('commander');

program
  .configureHelp({ showGlobalOptions: true })
  // Reject typos such as `pul-merge` instead of running the legacy download flow.
  .allowExcessArguments(false)
  .exitOverride()
  .option('--json', 'Print one JSON object to stdout (for agents and scripts)')
  .option(
    '--sourcemap-path <path>',
    'Composed Hermes source map from the exact installed release build'
  )
  .option(
    '--appId <id>',
    "Android application ID (selects that app's sessions; legacy: app to pull from)"
  )
  .option('--filename <string>', 'Legacy: profile file name to pull')
  .option('--generate-sourcemap', 'Legacy: generate a source map with Metro')
  .option('--port <number>', 'Legacy: Metro port')
  .option('--appIdSuffix <string>', 'Legacy: application ID suffix')
  .option('--fromDownload', 'Legacy: pull the profile from Downloads')
  .option('--raw', 'Legacy: pull the Hermes profile without converting it')
  .option('--local <string>', 'Legacy: convert a local Hermes profile')
  .option(
    '--merge-session <path>',
    'Merge an exported native and Hermes profiling session'
  )
  .addOption(
    new Option('--format <format>', 'Merged output format')
      .choices(['perfetto', 'simpleperf', 'folded'])
      .default('simpleperf')
  )
  .option(
    '--output <path>',
    'Output file (merge default: merged.trace / merged.perfetto-trace / merged.folded.txt)'
  );

program
  .command('pull-merge [session-id]')
  .description(
    'Pull the latest exported Android session (or a specified ID) and merge native and Hermes samples'
  )
  .option('--device <serial>', 'ADB device serial')
  .option('--directory <path>', 'Directory for downloaded sessions', '.')
  .addHelpText(
    'after',
    '\nRequired: --sourcemap-path <path> from the exact release build.\nOptional: --format simpleperf|perfetto (default: simpleperf), --output <path> (default: merged.trace).'
  )
  .action(async (sessionId: string | undefined, commandOptions: any) => {
    const options = { ...program.opts(), ...commandOptions };
    options.output ??= defaultOutput(options.format);
    const result = await pullMerge({
      sessionId,
      device: options.device,
      directory: options.directory,
      appId: options.appId,
      sourceMap: requireSourceMap(options, 'pull-merge'),
      output: options.output,
      format: options.format,
    });
    reportMerge('pull-merge', result);
  });

program
  .command('analyze [session]')
  .description(
    'Summarize a capture: JS hotspots with source lines, long tasks, native breakdown and capture quality'
  )
  .option(
    '--profile <path>',
    'Analyze a Hermes .cpuprofile without a session (JS only)'
  )
  .option(
    '--pull',
    'Pull the session from the device first (latest, or [session] as an ID)'
  )
  .option('--device <serial>', 'ADB device serial')
  .option('--directory <path>', 'Directory for pulled sessions', '.')
  .option('--long-task <ms>', 'Long task threshold in ms', '50')
  .option('--top <n>', 'Rows per table', '15')
  .addHelpText(
    'after',
    '\n[session] is session.json or its directory. Requires --sourcemap-path. With --output, writes JSON (*.json) or Markdown.'
  )
  .action(async (session: string | undefined, commandOptions: any) => {
    const options = { ...program.opts(), ...commandOptions };
    const sourceMap = requireSourceMap(options, 'analyze');
    let target = session;
    if (options.pull)
      target = pullSession({
        sessionId: session,
        device: options.device,
        directory: options.directory,
        appId: options.appId,
      }).directory;
    const report = await analyze({
      session: target,
      profile: options.profile,
      sourceMap,
      longTaskMs: Number(options.longTask),
      top: Number(options.top),
    });
    const markdown = renderAnalysis(report);
    if (options.output)
      fs.writeFileSync(
        options.output,
        options.output.endsWith('.json')
          ? JSON.stringify(report, null, 2)
          : markdown
      );
    emit('analyze', report, markdown);
  });

program
  .command('compare <before> <after>')
  .description(
    'Compare two `analyze --output <file>.json` reports, e.g. before and after a fix'
  )
  .action((before: string, after: string) => {
    const options = program.opts();
    const read = (file: string): AnalysisReport => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Accept both raw reports and `--json` envelopes.
      return parsed.command === 'analyze' ? parsed.result : parsed;
    };
    const comparison = compareReports(
      read(before),
      read(after),
      Number(options.top ?? 15)
    );
    emit('compare', comparison, renderComparison(comparison));
  });

program
  .command('doctor')
  .description(
    'Check the device, rate limiter, exported sessions and source map before recording or merging'
  )
  .option('--device <serial>', 'ADB device serial')
  .action((commandOptions: any) => {
    const options = { ...program.opts(), ...commandOptions };
    const checks = runDoctor({
      device: options.device,
      appId: options.appId,
      sourceMap: options.sourcemapPath,
    });
    emit('doctor', { checks }, renderDoctor(checks));
    if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
  });

program
  .command('install-skill <directory>')
  .description(
    "Copy the AI agent skill into an agent's skills directory (e.g. .claude/skills)"
  )
  .action((directory: string) => {
    const source = path.join(
      __dirname,
      '..',
      '..',
      'skills',
      'react-native-release-profiler'
    );
    const destination = path.resolve(
      directory,
      'react-native-release-profiler'
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    emit(
      'install-skill',
      { installed: destination },
      `Installed skill to ${destination}\n`
    );
  });

program.action(async () => {
  const options = program.opts();
  options.output ??= defaultOutput(options.format);
  const dstPath = '.';
  const task = options.mergeSession
    ? (async () => {
        const result = await mergeSession({
          session: options.mergeSession,
          sourceMap: requireSourceMap(options, '--merge-session'),
          output: options.output,
          format: options.format,
        });
        reportMerge('merge-session', result);
      })()
    : downloadProfile(
        options.local,
        options.fromDownload,
        dstPath,
        options.filename || getFilename(options.local),
        options.sourcemapPath,
        options.raw,
        options.generateSourcemap,
        options.port,
        options.appId,
        options.appIdSuffix
      );

  await task;
});

if (jsonMode) program.configureOutput({ writeErr: () => {} });

program.parseAsync().catch((error: any) => {
  // Commander already printed usage errors and help (exitOverride makes them throw).
  if (typeof error?.code === 'string' && error.code.startsWith('commander.')) {
    process.exitCode = error.exitCode ?? 1;
    if (!jsonMode || !process.exitCode) return;
  }
  const code = errorCode(error);
  if (jsonMode)
    process.stdout.write(
      JSON.stringify({ ok: false, error: { code, message: error.message } }) +
        '\n'
    );
  else logger.error(`${error.message} [${code}]`);
  process.exitCode = 1;
});
