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
  kind: 'js' | 'native' | 'meta' | 'root';
  source?: string;
  line?: number;
  column?: number;
  /** Hermes reports bytecode offset 0 for the innermost interpreted frame, so its
   * mapped line is the function's start rather than the executing statement. */
  entry?: boolean;
}

/** Count sampled bytecode functions (after the Metro prelude) that start at an offset
 * the map lists. Debug (source) profiles have no bytecode offsets: `checked` is 0.
 */
export function sourceMapMatch(
  map: { x_hermes_function_offsets?: Record<string, number[]> },
  profile: HermesProfile
): { checked: number; matched: number } {
  const offsets = Object.values(map.x_hermes_function_offsets ?? {}).flat();
  if (!offsets.length) return { checked: 0, matched: 0 };
  const known = new Set(offsets.map(Number));
  // Offset 0 is the global function; the Metro prelude (polyfills) between it and the
  // next listed function is not listed, so only check functions after that point.
  const first = Math.min(...[...known].filter((offset) => offset > 0));
  const sampled = new Set(
    Object.values(profile.stackFrames)
      .filter((frame) => frame.funcVirtAddr !== undefined)
      .map((frame) => Number(frame.funcVirtAddr))
      .filter((address) => address >= first)
  );
  return {
    checked: sampled.size,
    matched: [...sampled].filter((address) => known.has(address)).length,
  };
}

/** A map from another build still "resolves" frames, just to the wrong code. Hermes composed
 * maps list every function's bytecode start offset; sampled functions must start at one of them.
 */
export function assertSourceMapMatchesProfile(
  map: { x_hermes_function_offsets?: Record<string, number[]> },
  profile: HermesProfile
) {
  const hasOffsets = Object.values(map.x_hermes_function_offsets ?? {}).some(
    (offsets) => offsets.length
  );
  const jsFrames = Object.values(profile.stackFrames).filter(
    (frame) => frame.category === 'JavaScript'
  );
  const sourceFrames = jsFrames.filter(
    (frame) => frame.funcVirtAddr === undefined && frame.line !== undefined
  ).length;
  // Debug builds sample source positions in the dev-server bundle (a few precompiled
  // frames may still be bytecode); a release map would resolve them to unrelated code.
  if (hasOffsets && sourceFrames > jsFrames.length / 2) {
    throw new ProfilerError(
      'E_SOURCEMAP_MISMATCH',
      'The profile comes from a debug build (source positions) but the source map is a Hermes release (bytecode) map. Profile a release build, or use the dev server map for debug profiles.'
    );
  }
  const { checked, matched } = sourceMapMatch(map, profile);
  if (checked && matched < checked * 0.8) {
    throw new ProfilerError(
      'E_SOURCEMAP_MISMATCH',
      `Source map does not match the profiled build: only ${matched} of ${checked} sampled Hermes functions start at an offset listed in the map. Use the composed source map from the exact installed release build.`
    );
  }
}

/** Resolve every Hermes stack frame to its original function and source position. */
export async function symbolicateFrames(
  profile: HermesProfile,
  sourceMap: string
): Promise<{
  frames: Map<string, SymbolicatedFrame>;
  symbolicatedFrames: number;
  unmappedFrames: number;
}> {
  const rawSourceMap = JSON.parse(sourceMap);
  assertSourceMapMatchesProfile(rawSourceMap, profile);
  const frames = new Map<string, SymbolicatedFrame>();
  let symbolicatedFrames = 0;
  let unmappedFrames = 0;
  const consumer = await new SourceMapConsumer(rawSourceMap);
  try {
    for (const [key, frame] of Object.entries(profile.stackFrames)) {
      // Debug (source) profiles embed "(bundleURL:line:col)" in the name; the mapped
      // original location replaces it below.
      const fn =
        frame.name?.replace(/\(?[a-z]+:\/\/[^\s]*:\d+:\d+\)?$/i, '') ||
        '(anonymous)';
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
      if (frame.funcVirtAddr !== undefined && frame.offset !== undefined) {
        line = 1;
        column = Number(frame.funcVirtAddr) + Number(frame.offset);
      }
      // Where the function itself starts: bytecode address or (debug) source position.
      const start =
        frame.funcVirtAddr !== undefined
          ? { line: 1, column: Number(frame.funcVirtAddr) }
          : frame.funcLine !== undefined
          ? {
              line: Number(frame.funcLine),
              column: Number(frame.funcColumn) - 1,
            }
          : undefined;
      const functionId = start ? `${start.line}:${start.column}` : fn;
      let result: SymbolicatedFrame = {
        name: fn,
        function: fn,
        kind,
        functionId,
      };
      if (
        kind === 'js' &&
        Number.isSafeInteger(line) &&
        line >= 1 &&
        Number.isSafeInteger(column) &&
        column >= 0
      ) {
        const original = consumer.originalPositionFor({ line, column });
        if (original.source !== null && original.line !== null) {
          const name = original.name || fn;
          const originalColumn = (original.column ?? 0) + 1;
          const definition =
            start && Number.isSafeInteger(start.column) && start.column >= 0
              ? consumer.originalPositionFor(start)
              : undefined;
          result = {
            name: `${name} (${original.source}:${original.line}:${originalColumn})`,
            function: name,
            functionId,
            functionLine:
              definition?.source === original.source
                ? definition.line ?? undefined
                : undefined,
            kind,
            source: original.source,
            line: original.line,
            column: originalColumn,
            entry:
              frame.funcVirtAddr !== undefined && Number(frame.offset) === 0,
          };
          symbolicatedFrames++;
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
  if (!symbolicatedFrames)
    throw new ProfilerError(
      'E_SOURCEMAP_UNRESOLVED',
      'Source map did not resolve any JS frames; use the exact release composed Hermes source map'
    );
  return { frames, symbolicatedFrames, unmappedFrames };
}
