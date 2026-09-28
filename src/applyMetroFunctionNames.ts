import fs from 'fs';
import { logger } from '@react-native-community/cli-tools';
import { decode } from 'vlq';
import type transformer from '@margelo/hermes-profile-transformer';

type ProfileEvents = Awaited<ReturnType<typeof transformer>>;
type FunctionMapping = { line: number; column: number; name: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Restore enclosing function names after the transformer remaps file positions.
 * Metro encodes these separately from the standard source map `names` field:
 * https://metrobundler.dev/docs/source-map-format/#function-map
 * Updates events in place, preserving timing, categories, and original names
 * recorded by the transformer in `args.allocatedName`.
 */
export function applyMetroFunctionNames(
  events: ProfileEvents,
  sourceMapPath?: string
): void {
  if (!sourceMapPath) {
    return;
  }

  let sourceMap: unknown;
  try {
    sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));
  } catch {
    logger.warn('Cannot read source map for Metro function names');
    return;
  }

  // The transformer currently consumes flat source maps only.
  if (
    !isObject(sourceMap) ||
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.x_facebook_sources)
  ) {
    return;
  }

  const metadataBySource = new Map<string, unknown>();
  const sourceMetadata: unknown[] = sourceMap.x_facebook_sources;
  sourceMap.sources.forEach((source: unknown, index: number) => {
    if (typeof source === 'string') {
      const metadata = sourceMetadata[index];
      metadataBySource.set(
        source,
        Array.isArray(metadata) ? metadata[0] : null
      );
    }
  });
  const mappingsBySource = new Map<string, FunctionMapping[]>();
  let renamed = 0;
  let invalidMetadata = false;

  for (const event of events) {
    const args = event.args;
    if (
      !args ||
      typeof args.url !== 'string' ||
      !metadataBySource.has(args.url)
    ) {
      continue;
    }
    // Original source positions are one-based lines and zero-based columns.
    const line = Number(args.line);
    const column = Number(args.column);
    if (
      args.line == null ||
      args.column == null ||
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 1 ||
      column < 0
    ) {
      continue;
    }

    let mappings = mappingsBySource.get(args.url);
    if (!mappings) {
      try {
        mappings = decodeFunctionMap(metadataBySource.get(args.url));
      } catch {
        // Optional metadata must not prevent conversion of the profile.
        mappings = [];
        invalidMetadata = true;
      }
      mappingsBySource.set(args.url, mappings);
    }

    const name = findFunctionName(mappings, line, column);
    if (!name || name === '<global>') {
      continue;
    }
    if (event.name !== name) {
      renamed += 1;
    }
    event.name = name;
    args.name = name;
    args.params = name;
  }

  if (invalidMetadata) {
    logger.warn('Skipped invalid Metro function name metadata');
  }
  if (renamed > 0) {
    logger.info(`Applied Metro function names to ${renamed} events`);
  }
}

function decodeFunctionMap(functionMap: unknown): FunctionMapping[] {
  if (functionMap == null) {
    return [];
  }
  if (
    !isObject(functionMap) ||
    !Array.isArray(functionMap.names) ||
    typeof functionMap.mappings !== 'string'
  ) {
    throw new Error('Invalid Metro function map');
  }

  const parsed: FunctionMapping[] = [];
  let line = 1;
  let nameIndex = 0;
  for (const lineMappings of functionMap.mappings.split(';')) {
    // Semicolons reset the column; line numbers advance via explicit deltas.
    if (!lineMappings) {
      continue;
    }
    let column = 0;
    for (const mapping of lineMappings.split(',')) {
      // Require 2–3 complete VLQs; the decoder accepts unfinished values.
      if (!/^(?:[g-z0-9+/]{0,6}[A-Za-f]){2,3}$/.test(mapping)) {
        throw new Error('Incomplete Metro function mapping');
      }
      const values = decode(mapping);
      const [columnDelta, nameDelta, lineDelta = 0] = values;
      if (
        columnDelta === undefined ||
        nameDelta === undefined ||
        values.length > 3
      ) {
        throw new Error('Invalid Metro function mapping');
      }
      line += lineDelta;
      column += columnDelta;
      nameIndex += nameDelta;
      const name: unknown = functionMap.names[nameIndex];
      const previous = parsed[parsed.length - 1];
      if (
        line < 1 ||
        column < 0 ||
        typeof name !== 'string' ||
        (previous &&
          (line < previous.line ||
            (line === previous.line && column < previous.column)))
      ) {
        throw new Error('Invalid Metro function mapping position');
      }
      parsed.push({ line, column, name });
    }
  }
  return parsed;
}

function findFunctionName(
  mappings: FunctionMapping[],
  line: number,
  column: number
): string | undefined {
  let low = 0;
  let high = mappings.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const mapping = mappings[middle]!;
    if (
      mapping.line < line ||
      (mapping.line === line && mapping.column <= column)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return mappings[low - 1]?.name;
}
