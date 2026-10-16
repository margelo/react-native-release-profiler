import fs from 'fs';
import { SourceMapConsumer } from 'source-map';
import { ProfilerError } from './errors';
import type { HermesProfile } from './mergeProfiles';

export interface SymbolicatedFrame {
  /** Name used in exported traces, e.g. `fn (src/App.tsx:12:1)` or `[Native] jsonParse`. */
  name: string;
  /** Function name without the location. */
  function: string;
  /** Identifies the function itself (bytecode address or source start), so distinct
   * anonymous functions in one file stay separate. */
  functionId: string;
  /** Line where the function is defined, when known. */
  functionLine?: number;
  /** Column (1-based) where the function is defined, when `functionLine` is known. */
  functionColumn?: number;
  kind: 'js' | 'native' | 'meta' | 'root';
  source?: string;
  line?: number;
  column?: number;
  /** Hermes reports bytecode offset 0 for the innermost interpreted frame, so its
   * mapped line is the function's start rather than the executing statement. */
  entry?: boolean;
  /** Code from Hermes' own built-in bytecode (e.g. its Promise implementation), not the app. */
  hermesInternal?: boolean;
}

type HermesProfileFrame = HermesProfile['stackFrames'][string];
type HermesSourceMap = { x_hermes_function_offsets?: Record<string, unknown> };

/** Share of sampled functions that must start at an offset the map lists. A map from the
 * profiled build lists all of them; frames whose start is not listed are never resolved. */
export const MIN_FUNCTION_MATCH = 0.8;

/** Debug (source) profiles embed the bundle URL: `fn(http://host/index.bundle?...:12:3)`. */
const BUNDLE_URL = /\(?[a-z]+:\/\/[^\s]*:\d+:\d+\)?$/i;

/** The legacy `--raw` pull rewrote bytecode frames to line 1 and column
 * `funcVirtAddr + offset + 1`, dropping the address: still a release (bytecode) frame. */
function isRewrittenBytecodeFrame(frame: HermesProfileFrame): boolean {
  return (
    frame.funcVirtAddr === undefined &&
    frame.funcLine === undefined &&
    String(frame.line) === '1' &&
    /^[1-9]\d*$/.test(String(frame.column)) &&
    !BUNDLE_URL.test(frame.name ?? '')
  );
}

/** Where a bytecode frame executes: its function's start (when the profile kept it) and
 * the program counter, both bytecode offsets. */
function bytecodePosition(
  frame: HermesProfileFrame
): { start?: number; pc: number } | undefined {
  if (frame.funcVirtAddr !== undefined && frame.offset !== undefined) {
    const start = Number(frame.funcVirtAddr);
    return { start, pc: start + Number(frame.offset) };
  }
  if (isRewrittenBytecodeFrame(frame)) return { pc: Number(frame.column) - 1 };
  return undefined;
}

/** Release builds sample bytecode; so does a profile rewritten by an older legacy `--raw`. */
export function isBytecodeFrame(frame: HermesProfileFrame): boolean {
  return (
    frame.funcVirtAddr !== undefined ||
    (frame.line !== undefined && isRewrittenBytecodeFrame(frame))
  );
}

/** Whether frames lost their bytecode addresses to an older legacy `--raw` pull, so no
 * source map can be verified against them. */
export function hasRewrittenFrames(profile: HermesProfile): boolean {
  return Object.values(profile.stackFrames ?? {}).some(
    (frame) =>
      frame.category === 'JavaScript' && isRewrittenBytecodeFrame(frame)
  );
}

function isSourceFrame(frame: HermesProfileFrame): boolean {
  return frame.line !== undefined && !isBytecodeFrame(frame);
}

/** Function start offsets listed by a composed Hermes map. */
interface FunctionStarts {
  listed: Set<number>;
  sorted: number[];
  /** The first function after the global function (offset 0). Addresses below it are
   * inside the app's global function, so they are Hermes' internal bytecode. */
  first: number;
}

/** Functions of Hermes' internal bytecode (its Promise implementation). Their addresses are
 * relative to that bytecode, so they can also fall between app functions (RN 0.88: 27776). */
const HERMES_INTERNAL_FUNCTIONS = new Set([
  'Promise',
  'tryCallOne',
  'tryCallTwo',
  'doResolve',
  'handle',
  'handleResolved',
  'finale',
  'getThen',
  'safeThen',
  'valuePromise',
  'resolve',
  'reject',
]);

const isAnonymousName = (name: string | undefined) =>
  !name || name === '(anonymous)' || /^\?anon_\d+_$/.test(name);

/** A sampled function the map does not list that is Hermes' internal bytecode, either
 * by address or by name. */
function isHermesInternal(
  starts: FunctionStarts,
  start: number,
  name: string | undefined
): boolean {
  return (
    !starts.listed.has(start) &&
    (start < starts.first || HERMES_INTERNAL_FUNCTIONS.has(name ?? ''))
  );
}

function functionStarts(map: HermesSourceMap): FunctionStarts | undefined {
  const offsets = map.x_hermes_function_offsets;
  if (!offsets || typeof offsets !== 'object') return undefined;
  const listed = new Set<number>();
  for (const segment of Object.values(offsets))
    if (Array.isArray(segment))
      for (const offset of segment) {
        const value = Number(offset);
        if (Number.isSafeInteger(value) && value >= 0) listed.add(value);
      }
  if (!listed.size) return undefined;
  // Large apps list hundreds of thousands of functions: never spread them into arguments.
  const sorted = [...listed].sort((a, b) => a - b);
  return { listed, sorted, first: sorted.find((o) => o > 0) ?? Infinity };
}

/** The listed function that contains `pc` (largest start <= pc). */
function containingStart(starts: FunctionStarts, pc: number): number {
  let low = 0;
  let high = starts.sorted.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts.sorted[mid]! <= pc) low = mid;
    else high = mid - 1;
  }
  return starts.sorted[low]!;
}

/** Count sampled bytecode functions (after the app's global function) that start at an
 * offset the map lists. Debug (source) profiles have no bytecode offsets: `checked` is 0.
 * Unlisted Hermes-internal and unnamed functions are not counted: with the right map they
 * can only be Hermes' internal bytecode, and named app functions still expose a wrong map.
 */
export function sourceMapMatch(
  map: HermesSourceMap,
  profile: HermesProfile
): { checked: number; matched: number } {
  const starts = functionStarts(map);
  if (!starts) return { checked: 0, matched: 0 };
  const sampled = new Set<number>();
  for (const frame of Object.values(profile.stackFrames ?? {})) {
    const start = bytecodePosition(frame)?.start;
    if (start === undefined || start < starts.first) continue;
    if (
      !starts.listed.has(start) &&
      (isAnonymousName(frame.name) ||
        isHermesInternal(starts, start, frame.name))
    )
      continue;
    sampled.add(start);
  }
  let matched = 0;
  for (const start of sampled) if (starts.listed.has(start)) matched++;
  return { checked: sampled.size, matched };
}

/** Whether enough sampled functions start at listed offsets (see `MIN_FUNCTION_MATCH`). */
export function sourceMapMatchAccepted({
  checked,
  matched,
}: {
  checked: number;
  matched: number;
}): boolean {
  return matched >= checked * MIN_FUNCTION_MATCH;
}

/** A map from another build still "resolves" frames, just to the wrong code. Hermes composed
 * maps list every function's bytecode start offset; sampled functions must start at one of them.
 */
export function assertSourceMapMatchesProfile(
  map: HermesSourceMap,
  profile: HermesProfile
) {
  const hasOffsets = functionStarts(map) !== undefined;
  const jsFrames = Object.values(profile.stackFrames ?? {}).filter(
    (frame) => frame.category === 'JavaScript'
  );
  // Debug builds sample source positions in the dev-server bundle (Hermes' internal
  // bytecode still shows up as a few bytecode frames); a release map would resolve them
  // to unrelated code.
  const sourceFrames = jsFrames.filter(isSourceFrame).length;
  if (hasOffsets && sourceFrames > jsFrames.length / 2) {
    throw new ProfilerError(
      'E_SOURCEMAP_MISMATCH',
      'The profile comes from a debug build (source positions) but the source map is a Hermes release (bytecode) map. Profile a release build, or use the dev server map for debug profiles.'
    );
  }
  // Release builds sample bytecode offsets, which only the composed Hermes map describes;
  // a packager or dev-server map would resolve them to arbitrary code.
  const bytecodeFrames = jsFrames.filter(isBytecodeFrame).length;
  if (!hasOffsets && bytecodeFrames > jsFrames.length / 2) {
    throw new ProfilerError(
      'E_SOURCEMAP_UNRESOLVED',
      'The profile comes from a release build (Hermes bytecode) but the source map has no Hermes function offsets: use the composed source map of the exact release build (android/app/build/generated/sourcemaps/react/release/index.android.bundle.map).'
    );
  }
  const match = sourceMapMatch(map, profile);
  if (!sourceMapMatchAccepted(match)) {
    throw new ProfilerError(
      'E_SOURCEMAP_MISMATCH',
      `Source map does not match the profiled build: only ${match.matched} of ${match.checked} sampled Hermes functions start at an offset listed in the map. Use the composed source map from the exact installed release build.`
    );
  }
}

/** Parse source map text, failing with E_USAGE when it is not a source map at all. */
export function parseSourceMap(text: string): any {
  let map: any;
  try {
    map = JSON.parse(text);
  } catch (error) {
    throw new ProfilerError(
      'E_USAGE',
      `--sourcemap-path is not valid JSON (${
        (error as Error).message
      }); pass the composed source map (.map) of the release build`
    );
  }
  if (
    !map ||
    typeof map !== 'object' ||
    (typeof map.mappings !== 'string' && !Array.isArray(map.sections))
  )
    throw new ProfilerError(
      'E_USAGE',
      '--sourcemap-path is not a source map (no "mappings"); pass the composed source map (.map) of the release build'
    );
  return map;
}

/** Read and check a Hermes `.cpuprofile`; a missing, truncated or malformed file is
 * E_HERMES_PROFILE. */
export function readHermesProfile(file: string): HermesProfile {
  let profile: HermesProfile;
  try {
    profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ProfilerError(
      'E_HERMES_PROFILE',
      `Cannot read Hermes profile ${file}: ${
        (error as Error).message
      }. Re-pull the session (or re-record)`
    );
  }
  const problem =
    !profile || typeof profile !== 'object'
      ? 'is not a Hermes profile'
      : !Array.isArray(profile.samples) || !profile.samples.length
      ? 'has no samples'
      : !profile.stackFrames ||
        typeof profile.stackFrames !== 'object' ||
        !Object.keys(profile.stackFrames).length
      ? 'has no stack frames'
      : profile.samples.some(
          (sample) =>
            !sample ||
            !(
              (typeof sample.ts === 'string' && /^\d+$/.test(sample.ts)) ||
              (typeof sample.ts === 'number' &&
                Number.isSafeInteger(sample.ts) &&
                sample.ts >= 0)
            )
        )
      ? 'is corrupt (a sample has no integer timestamp)'
      : undefined;
  if (problem)
    throw new ProfilerError(
      'E_HERMES_PROFILE',
      `Hermes profile ${file} ${problem}. Re-pull the session (or re-record)`
    );
  return profile;
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) return [];
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

interface FunctionRange {
  line: number;
  column: number;
  name: string;
}

/** Metro's per-source function map (`x_facebook_sources[i][0]`): the name of the function
 * that encloses each source range. `;` separates lines; each segment is column (relative within
 * the line), name index (relative) and, on a line's first segment, the line delta.
 */
export function decodeFunctionMap(map: {
  names: string[];
  mappings: string;
}): FunctionRange[] {
  const ranges: FunctionRange[] = [];
  let line = 1;
  let name = 0;
  for (const lineMappings of map.mappings.split(';')) {
    let column = 0;
    let first = true;
    for (const segment of lineMappings.split(',')) {
      if (!segment) continue;
      const [columnDelta = 0, nameDelta = 0, lineDelta] = decodeVlq(segment);
      column += columnDelta;
      name += nameDelta;
      if (first && lineDelta !== undefined) line += lineDelta;
      first = false;
      const resolved = map.names[name];
      if (resolved !== undefined) ranges.push({ line, column, name: resolved });
    }
  }
  return ranges;
}

function enclosingFunction(
  ranges: FunctionRange[] | undefined,
  line: number,
  column: number
): string | undefined {
  if (!ranges) return undefined;
  let found: string | undefined;
  for (const range of ranges) {
    if (range.line > line || (range.line === line && range.column > column))
      break;
    found = range.name;
  }
  return found === '<global>' || found === '<anonymous>' ? undefined : found;
}

/** Resolve every Hermes stack frame to its original function and source position. */
export async function symbolicateFrames(
  profile: HermesProfile,
  sourceMap: string
): Promise<{
  frames: Map<string, SymbolicatedFrame>;
  symbolicatedFrames: number;
  unmappedFrames: number;
  /** Frames resolved without a bytecode address to check the map against (rewritten by an
   * older legacy `--raw` pull): correct only if the map is from the exact build. */
  unverifiedFrames: number;
}> {
  const rawSourceMap = parseSourceMap(sourceMap);
  assertSourceMapMatchesProfile(rawSourceMap, profile);
  const starts = functionStarts(rawSourceMap);
  const jsFrames = Object.values(profile.stackFrames).filter(
    (frame) => frame.category === 'JavaScript'
  );
  const debugProfile =
    jsFrames.filter(isSourceFrame).length > jsFrames.length / 2;
  const frames = new Map<string, SymbolicatedFrame>();
  let symbolicatedFrames = 0;
  let unmappedFrames = 0;
  let unverifiedFrames = 0;
  let consumer: SourceMapConsumer;
  try {
    consumer = await new SourceMapConsumer(rawSourceMap);
  } catch (error) {
    throw new ProfilerError(
      'E_USAGE',
      `--sourcemap-path is not a usable source map (${
        (error as Error).message
      }); pass the composed source map (.map) of the release build`
    );
  }
  // Function names come from Hermes (and Metro's function map for anonymous functions),
  // never from source-map `names`: those are identifier tokens at the mapped position
  // (`JSON`, `i`, a callee) rather than the function that was executing.
  const functionMaps = new Map<string, FunctionRange[]>();
  const rawSources: string[] = rawSourceMap.sources ?? [];
  const consumerSources: string[] = (consumer as any).sources ?? [];
  rawSources.forEach((source, i) => {
    const functionMap = rawSourceMap.x_facebook_sources?.[i]?.[0];
    if (!functionMap?.mappings || !Array.isArray(functionMap.names)) return;
    const ranges = decodeFunctionMap(functionMap);
    functionMaps.set(source, ranges);
    if (consumerSources.length === rawSources.length && consumerSources[i])
      functionMaps.set(consumerSources[i]!, ranges);
  });
  try {
    for (const [key, frame] of Object.entries(profile.stackFrames)) {
      // Debug (source) profiles embed "(bundleURL:line:col)" in the name; the mapped
      // original location replaces it below.
      const fn = frame.name?.replace(BUNDLE_URL, '') || '(anonymous)';
      const kind: SymbolicatedFrame['kind'] =
        frame.category === 'JavaScript' || frame.category === undefined
          ? 'js'
          : frame.category === 'root'
          ? 'root'
          : frame.category === 'Native'
          ? 'native'
          : 'meta';
      let line = Number(frame.line);
      let column = Number(frame.column) - 1;
      // Where the function itself starts: bytecode address or (debug) source position.
      let start: { line: number; column: number } | undefined =
        frame.funcLine !== undefined
          ? {
              line: Number(frame.funcLine),
              column: Number(frame.funcColumn) - 1,
            }
          : undefined;
      let entry = false;
      // Bytecode the app map cannot describe: Hermes' internal bytecode, or (with a map
      // from a slightly different build) a function that starts at an unlisted offset.
      let skip: 'internal' | 'unlisted' | undefined;
      const bytecode = kind === 'js' ? bytecodePosition(frame) : undefined;
      if (bytecode) {
        let functionStart = bytecode.start;
        if (starts) {
          if (functionStart === undefined)
            // Rewritten by the legacy --raw pull: the enclosing listed function.
            functionStart =
              bytecode.pc < starts.first && fn !== 'global'
                ? bytecode.pc
                : containingStart(starts, bytecode.pc);
          if (!starts.listed.has(functionStart))
            skip = isHermesInternal(starts, functionStart, fn)
              ? 'internal'
              : 'unlisted';
        } else if (debugProfile) skip = 'internal';
        line = 1;
        column = bytecode.pc;
        if (functionStart !== undefined) {
          start = { line: 1, column: functionStart };
          entry = bytecode.pc === functionStart;
        }
      }
      const functionId = start ? `${start.line}:${start.column}` : fn;
      let result: SymbolicatedFrame = {
        name: fn,
        function: fn,
        kind,
        functionId,
      };
      if (skip === 'internal') {
        result.name += ' [Hermes internal]';
        result.hermesInternal = true;
      } else if (skip === 'unlisted') {
        unmappedFrames++;
        result.name += ' [unmapped JS]';
      } else if (
        kind === 'js' &&
        Number.isSafeInteger(line) &&
        line >= 1 &&
        Number.isSafeInteger(column) &&
        column >= 0
      ) {
        const original = consumer.originalPositionFor({ line, column });
        if (original.source !== null && original.line !== null) {
          const anonymous = isAnonymousName(fn);
          const name =
            (anonymous &&
              enclosingFunction(
                functionMaps.get(original.source),
                original.line,
                original.column ?? 0
              )) ||
            fn;
          const originalColumn = (original.column ?? 0) + 1;
          const definition =
            start && Number.isSafeInteger(start.column) && start.column >= 0
              ? consumer.originalPositionFor(start)
              : undefined;
          const defined =
            definition?.source === original.source && definition.line !== null;
          result = {
            name: `${name} (${original.source}:${original.line}:${originalColumn})`,
            function: name,
            functionId,
            functionLine: defined ? definition.line! : undefined,
            functionColumn: defined ? (definition.column ?? 0) + 1 : undefined,
            kind,
            source: original.source,
            line: original.line,
            column: originalColumn,
            entry,
          };
          symbolicatedFrames++;
          if (bytecode && bytecode.start === undefined) unverifiedFrames++;
        } else {
          unmappedFrames++;
          result.name += ' [unmapped JS]';
        }
      } else if (frame.category === 'JavaScript') {
        unmappedFrames++;
        result.name += ' [unmapped JS]';
      }
      frames.set(key, result);
    }
  } finally {
    consumer.destroy();
  }
  // Only blame the map when it had app frames to resolve.
  if (!symbolicatedFrames && unmappedFrames)
    throw new ProfilerError(
      'E_SOURCEMAP_UNRESOLVED',
      'Source map did not resolve any JS frames; use the exact release composed Hermes source map'
    );
  return { frames, symbolicatedFrames, unmappedFrames, unverifiedFrames };
}
