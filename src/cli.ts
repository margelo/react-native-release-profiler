#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { downloadProfile } from './legacy';
import { loadSession, mergeSession, type MergeFormat } from './mergeProfiles';
import { pullMerge, pullSession } from './pullMerge';
import { analyze, renderAnalysis } from './analyze';
import { compareReports, readReport, renderComparison } from './compare';
import { renderDoctor, runDoctor } from './doctor';
import { errorCode, ProfilerError } from './errors';
import {
  assertOutputIsNotInput,
  checkSourceMapFile,
  positiveNumber,
  prepareOutput,
  requireFile,
  sessionManifestPath,
} from './cliInputs';

// `--json`: print exactly one JSON object to stdout and nothing else, for agents and scripts.
const jsonMode = process.argv.includes('--json');
if (jsonMode) logger.disable();

function emit(command: string, result: unknown, text?: string) {
  if (jsonMode)
    process.stdout.write(JSON.stringify({ ok: true, command, result }) + '\n');
  else if (text) process.stdout.write(text);
}

/** A command that ran but whose result is a failure: exit 1 and `ok: false` agree. */
function emitFailure(
  command: string,
  result: unknown,
  error: ProfilerError,
  text?: string
) {
  if (jsonMode)
    process.stdout.write(
      JSON.stringify({
        ok: false,
        command,
        result,
        error: { code: error.code, message: error.message },
      }) + '\n'
    );
  else if (text) process.stdout.write(text);
  process.exitCode = 1;
}

/** Legacy-only global options (option key → flag). */
const LEGACY_FLAGS: Record<string, string> = {
  local: '--local',
  fromDownload: '--fromDownload',
  raw: '--raw',
  filename: '--filename',
  generateSourcemap: '--generate-sourcemap',
  port: '--port',
  appIdSuffix: '--appIdSuffix',
};

/** Global options that pull-merge would otherwise silently ignore. */
function rejectIgnoredOptions(command: string, options: any) {
  if (options.mergeSession !== undefined)
    throw new ProfilerError(
      'E_USAGE',
      `${command} pulls a session from the device and does not take --merge-session. To merge a session already on disk, run \`npx react-native-release-profiler --merge-session <path/to/session.json> --sourcemap-path <map>\` (no subcommand).`
    );
  const legacy = Object.keys(LEGACY_FLAGS).find(
    (key) => options[key] !== undefined
  );
  if (legacy)
    throw new ProfilerError(
      'E_USAGE',
      `${command} does not take ${LEGACY_FLAGS[legacy]} (a legacy Hermes-only option)`
    );
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
  warnings.push(...(result.nativeWarnings ?? []));
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
  return requireFile(options.sourcemapPath, 'Source map');
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
  .option(
    '--device <serial>',
    'ADB device serial (default: ANDROID_SERIAL, or the only connected device)'
  )
  .option('--fromDownload', 'Legacy: pull the profile from Downloads')
  .option('--raw', 'Legacy: pull the Hermes profile without converting it')
  .option('--local <string>', 'Legacy: convert a local Hermes profile')
  .option(
    '--merge-session <path>',
    'Merge an exported native and Hermes profiling session (session.json or its directory)'
  )
  .addOption(
    new Option('--format <format>', 'Merged output format')
      .choices(['perfetto', 'simpleperf', 'folded'])
      .default('simpleperf')
  )
  .option(
    '--output <path>',
    'Output file (merge default: merged.trace / merged.perfetto-trace / merged.folded.txt; legacy default: <profile>-converted.json)'
  );

program
  .command('pull-merge [session-id]')
  .description(
    'Pull the latest exported Android session (or a specified ID) and merge native and Hermes samples'
  )
  .option('--directory <path>', 'Directory for downloaded sessions', '.')
  .addHelpText(
    'after',
    '\nRequired: --sourcemap-path <path> from the exact release build.\nOptional: --format simpleperf|perfetto|folded (default: simpleperf), --output <path> (default: merged.trace), --device <serial>.\nFor a session already on disk use `--merge-session <session.json>` without pull-merge.'
  )
  .action(async (sessionId: string | undefined, commandOptions: any) => {
    const options = { ...program.opts(), ...commandOptions };
    rejectIgnoredOptions('pull-merge', options);
    options.output ??= defaultOutput(options.format);
    const sourceMap = requireSourceMap(options, 'pull-merge');
    checkSourceMapFile(sourceMap);
    prepareOutput(options.output);
    const result = await pullMerge({
      sessionId,
      device: options.device,
      directory: options.directory,
      appId: options.appId,
      sourceMap,
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
    const longTaskMs = positiveNumber(options.longTask, '--long-task', false);
    const top = positiveNumber(options.top, '--top', true);
    const sourceMap = requireSourceMap(options, 'analyze');
    const profile = options.profile && requireFile(options.profile, 'Profile');
    if (options.output) prepareOutput(options.output);
    let target =
      session && !options.pull ? sessionManifestPath(session) : undefined;
    let pulled: string | undefined;
    if (options.pull) {
      checkSourceMapFile(sourceMap);
      pulled = pullSession({
        sessionId: session,
        device: options.device,
        directory: options.directory,
        appId: options.appId,
      }).directory;
      target = path.join(pulled, 'session.json');
    }
    try {
      if (options.output) {
        const inputs = target ? loadSession(target) : undefined;
        assertOutputIsNotInput(options.output, [
          sourceMap,
          profile,
          target,
          inputs?.hermesPath,
          inputs?.nativePath,
        ]);
      }
      const report = await analyze({
        session: target,
        profile,
        sourceMap,
        longTaskMs,
        top,
      });
      const markdown = renderAnalysis(report);
      if (options.output)
        try {
          fs.writeFileSync(
            options.output,
            options.output.endsWith('.json')
              ? JSON.stringify(report, null, 2)
              : markdown
          );
        } catch (error) {
          throw new ProfilerError(
            'E_USAGE',
            `Cannot write --output ${options.output}: ${
              (error as Error).message
            }`
          );
        }
      emit(
        'analyze',
        pulled ? { ...report, sessionDirectory: pulled } : report,
        markdown
      );
    } catch (error) {
      // The download is kept: say where, so a retry can analyze it without pulling again.
      if (pulled && error && typeof error === 'object')
        (error as { sessionDirectory?: string }).sessionDirectory = pulled;
      throw error;
    }
  });

program
  .command('compare <before> <after>')
  .description(
    'Compare two `analyze --output <file>.json` reports, e.g. before and after a fix'
  )
  .option('--top <n>', 'Rows in the function table', '15')
  .action((before: string, after: string, commandOptions: any) => {
    const top = positiveNumber(commandOptions.top, '--top', true);
    const comparison = compareReports(
      readReport(before),
      readReport(after),
      top
    );
    emit('compare', comparison, renderComparison(comparison));
  });

program
  .command('doctor')
  .description(
    'Check the device, rate limiter, exported sessions and source map before recording or merging'
  )
  .addHelpText(
    'after',
    '\nOptional: --appId <id>, --sourcemap-path <map>, --device <serial>.'
  )
  .action(async (commandOptions: any) => {
    const options = { ...program.opts(), ...commandOptions };
    const checks = await runDoctor({
      device: options.device,
      appId: options.appId,
      sourceMap: options.sourcemapPath,
    });
    const failed = checks.filter((check) => check.status === 'fail');
    if (!failed.length) return emit('doctor', { checks }, renderDoctor(checks));
    emitFailure(
      'doctor',
      { checks },
      new ProfilerError(
        'E_DOCTOR_FAILED',
        `${failed.length} check(s) failed: ${failed
          .map((check) => `${check.check}: ${check.detail}`)
          .join('; ')}`
      ),
      renderDoctor(checks)
    );
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
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true });
    } catch (error) {
      throw new ProfilerError(
        'E_USAGE',
        `Cannot install the skill into ${destination}: ${
          (error as Error).message
        }`
      );
    }
    emit(
      'install-skill',
      { installed: destination },
      `Installed skill to ${destination}\n`
    );
  });

program.action(async () => {
  const options = program.opts();
  if (options.mergeSession) {
    const sourceMap = requireSourceMap(options, '--merge-session');
    const session = sessionManifestPath(options.mergeSession);
    const output = options.output ?? defaultOutput(options.format);
    prepareOutput(output);
    const result = await mergeSession({
      session,
      sourceMap,
      output,
      format: options.format,
    });
    return reportMerge('merge-session', result);
  }
  const result = await downloadProfile({
    local: options.local,
    fromDownload: options.fromDownload,
    filename: options.filename,
    sourcemapPath: options.sourcemapPath,
    raw: options.raw,
    generateSourcemap: options.generateSourcemap,
    port: options.port,
    appId: options.appId,
    appIdSuffix: options.appIdSuffix,
    device: options.device,
    output: options.output,
  });
  // Text mode already logged progress, warnings and the output path.
  if (jsonMode) emit('legacy', result);
});

// In JSON mode, help is returned inside the JSON object and usage errors as error JSON.
let helpText = '';
if (jsonMode)
  program.configureOutput({
    writeOut: (text: string) => (helpText += text),
    writeErr: () => {},
  });

/** Settles when the command has finished (tests await it). */
export const completed = program.parseAsync().catch((error: any) => {
  // Commander already printed usage errors and help (exitOverride makes them throw).
  if (typeof error?.code === 'string' && error.code.startsWith('commander.')) {
    process.exitCode = error.exitCode ?? 1;
    if (jsonMode && !process.exitCode && helpText)
      return emit('help', { text: helpText });
    if (!jsonMode || !process.exitCode) return;
  }
  const code = errorCode(error);
  const sessionDirectory: string | undefined = error?.sessionDirectory;
  if (jsonMode)
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: {
          code,
          message: error?.message ?? String(error),
          ...(sessionDirectory ? { sessionDirectory } : {}),
        },
      }) + '\n'
    );
  else {
    logger.error(`${error?.message ?? error} [${code}]`);
    if (sessionDirectory)
      logger.info(
        `The pulled session is kept in ${sessionDirectory}; re-run analyze on it instead of --pull`
      );
  }
  process.exitCode = 1;
});
