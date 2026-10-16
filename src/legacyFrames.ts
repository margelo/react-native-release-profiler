import type { HermesProfile } from './mergeProfiles';

type Frame = HermesProfile['stackFrames'][string];

/** Prepare a Hermes profile for the legacy Chrome-trace conversion
 * (`@margelo/hermes-profile-transformer`) so that one JS function is one frame.
 *
 * Hermes keeps a stack-frame node per sampled call site (bytecode offset). The transformer
 * ends a slice and starts another whenever the sampled node changes, and copies the node's
 * line/column into the event args, which SpeedScope uses to tell functions apart. One call
 * therefore became several slices, and one function a symbol per sampled line. Nodes of the
 * same function under the same (merged) caller become one node, positioned at the function's
 * start so the source map resolves it to the line where the function is defined.
 */
export function functionLevelProfile(profile: HermesProfile): HermesProfile {
  const merged = new Map<string, string>(); // frame key -> key of the merged node
  const nodes = new Map<string, string>(); // merged parent + function -> merged key
  const stackFrames: Record<string, Frame> = {};
  const resolve = (key: string, visiting = new Set<string>()): string => {
    const known = merged.get(key);
    if (known !== undefined) return known;
    const frame = profile.stackFrames[key];
    // Missing or cyclic frames are left as they are; the conversion reports them.
    if (!frame || visiting.has(key)) return key;
    visiting.add(key);
    const parent =
      frame.parent === undefined
        ? undefined
        : resolve(String(frame.parent), visiting);
    const bytecode =
      frame.funcVirtAddr !== undefined &&
      Number.isSafeInteger(Number(frame.funcVirtAddr));
    const source =
      !bytecode &&
      frame.funcLine !== undefined &&
      Number.isSafeInteger(Number(frame.funcLine)) &&
      Number.isSafeInteger(Number(frame.funcColumn));
    // Native, GC and root frames have no position: their name identifies them.
    const identity = bytecode
      ? `bytecode ${frame.funcVirtAddr}`
      : source
      ? `source ${frame.funcLine}:${frame.funcColumn}`
      : `frame ${frame.category}\0${frame.name}\0${frame.line}\0${frame.column}`;
    const node = `${parent}\0${identity}`;
    let target = nodes.get(node);
    if (target === undefined) {
      target = key;
      nodes.set(node, key);
      const { offset, ...rest } = frame;
      const result: Frame = { ...rest };
      if (bytecode) {
        // Hermes composed source maps address bytecode as line 1, column = offset.
        delete result.funcVirtAddr;
        result.line = '1';
        result.column = String(Number(frame.funcVirtAddr));
      } else if (source) {
        result.line = String(frame.funcLine);
        result.column = String(Number(frame.funcColumn) - 1);
      } else if (offset !== undefined) {
        result.offset = offset;
      }
      if (parent !== undefined)
        result.parent =
          typeof frame.parent === 'number' ? Number(parent) : parent;
      stackFrames[key] = result;
    }
    merged.set(key, target);
    return target;
  };
  for (const key of Object.keys(profile.stackFrames)) resolve(key);
  return {
    ...profile,
    stackFrames,
    samples: profile.samples.map((sample) => {
      const sf = resolve(String(sample.sf));
      return { ...sample, sf: typeof sample.sf === 'number' ? Number(sf) : sf };
    }),
  };
}

/** The transformer copies each node's Hermes `parent` ID into the event args, so SpeedScope
 * would still list a function once per caller. The ID means nothing to a reader; drop it.
 */
export function withoutNodeIds<T extends { args?: object }>(events: T[]): T[] {
  for (const event of events)
    if (event.args && 'parent' in event.args)
      delete (event.args as { parent?: unknown }).parent;
  return events;
}
