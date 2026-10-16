import fs from 'fs';
import os from 'os';
import path from 'path';
import transformer from '@margelo/hermes-profile-transformer';
import { functionLevelProfile, withoutNodeIds } from '../legacyFrames';
import type { HermesProfile } from '../mergeProfiles';

// `caller` calls `work`; Hermes sampled `work` at three offsets (one node each) and each
// node has its own `[Native] jsonParse` child.
const profile: HermesProfile = {
  stackFrames: {
    1: { name: '[root]', category: 'root' },
    2: {
      name: 'caller',
      category: 'JavaScript',
      funcVirtAddr: '50',
      offset: '3',
      parent: 1,
    },
    3: {
      name: 'work',
      category: 'JavaScript',
      funcVirtAddr: '100',
      offset: '5',
      parent: 2,
    },
    4: {
      name: 'work',
      category: 'JavaScript',
      funcVirtAddr: '100',
      offset: '9',
      parent: 2,
    },
    5: { name: '[Native] jsonParse', category: 'Native', parent: 3 },
    6: { name: '[Native] jsonParse', category: 'Native', parent: 4 },
    7: {
      name: 'work',
      category: 'JavaScript',
      funcVirtAddr: '100',
      offset: '0',
      parent: 2,
    },
  },
  samples: [3, 5, 4, 6, 7, 3].map((sf, i) => ({
    ts: String(1000 + i * 10_000),
    pid: 10,
    tid: '11',
    sf,
  })),
};

describe('functionLevelProfile', () => {
  it('merges the stack-frame nodes of one function under the same caller', () => {
    const merged = functionLevelProfile(profile);
    expect(Object.keys(merged.stackFrames)).toEqual(['1', '2', '3', '5']);
    expect(merged.samples.map((s) => s.sf)).toEqual([3, 5, 3, 5, 3, 3]);
    expect(merged.stackFrames[5]!.parent).toBe(3);
  });

  it('positions bytecode frames at the function start', () => {
    const { stackFrames } = functionLevelProfile(profile);
    expect(stackFrames[3]).toEqual({
      name: 'work',
      category: 'JavaScript',
      line: '1',
      column: '100',
      parent: 2,
    });
  });

  it('positions source (debug) frames at the function start', () => {
    const debug: HermesProfile = {
      stackFrames: {
        1: { name: '[root]', category: 'root' },
        2: {
          name: 'f(http://localhost:8081/index.bundle:120:9)',
          category: 'JavaScript',
          line: '120',
          column: '9',
          funcLine: '118',
          funcColumn: '5',
          parent: 1,
        },
        3: {
          name: 'f(http://localhost:8081/index.bundle:125:2)',
          category: 'JavaScript',
          line: '125',
          column: '2',
          funcLine: '118',
          funcColumn: '5',
          parent: 1,
        },
      },
      samples: [2, 3].map((sf) => ({ ts: '1', pid: 1, tid: '1', sf })),
    };
    const merged = functionLevelProfile(debug);
    expect(Object.keys(merged.stackFrames)).toEqual(['1', '2']);
    expect(merged.stackFrames[2]).toMatchObject({ line: '118', column: '4' });
    expect(merged.samples.map((s) => s.sf)).toEqual([2, 2]);
  });

  it('gives the legacy transformer one slice per call and one symbol per function', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-legacy-'));
    const file = path.join(dir, 'profile.cpuprofile');
    const convert = async (input: HermesProfile) => {
      fs.writeFileSync(file, JSON.stringify(input));
      return withoutNodeIds(await transformer(file, undefined, 'index.bundle'));
    };
    const work = (events: Awaited<ReturnType<typeof convert>>) =>
      events.filter((e) => e.name === 'work' && e.ph === 'B');
    // Without merging, every change of sampled offset ends the slice.
    expect(work(await convert(profile))).toHaveLength(4);
    const merged = work(await convert(functionLevelProfile(profile)));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.args).not.toHaveProperty('parent');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
