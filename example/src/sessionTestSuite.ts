import { NativeModules } from 'react-native';
import {
  startProfiling,
  startProfilingSession,
  stopProfiling,
  type ProfilingSession,
  type ProfilingSessionArtifacts,
} from 'react-native-release-profiler';

// On-device regression suite for the combined session API (TEST_PLAN_rp-2.0.md).
// Results are logged as `[RPTEST] PASS|FAIL <id> ...` so they can be read with `adb logcat`.

type Result = { id: string; pass: boolean; detail: string };
type Case = { id: string; run: () => Promise<string> };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    return { code: String(error?.code ?? ''), message: String(error?.message) };
  }
  throw new Error('Expected a rejection');
}

function burn(ms: number) {
  const deadline = performance.now() + ms;
  let value = 0;
  while (performance.now() < deadline) value += Math.sqrt(value + 1);
  return value;
}

async function record(
  options: Parameters<typeof startProfilingSession>[0],
  ms: number,
  saveToDownloads = false
): Promise<ProfilingSessionArtifacts> {
  const session = await startProfilingSession(options);
  burn(ms);
  return session.stop(saveToDownloads);
}

function describe(artifacts: ProfilingSessionArtifacts) {
  return `native=${artifacts.nativeStatus} error=${
    artifacts.nativeError
  } downloads=${artifacts.downloadUris?.length ?? 0}`;
}

const cases: Case[] = [
  {
    id: 'API-02/03 artifacts + export',
    run: async () => {
      const artifacts = await record({ durationMs: 5000 }, 1000, true);
      assert(
        /^[0-9a-f-]{36}$/.test(artifacts.sessionId),
        'sessionId is not a UUID'
      );
      assert(artifacts.manifestPath.endsWith('/session.json'), 'manifestPath');
      assert(
        artifacts.hermesProfilePath.endsWith('/hermes.cpuprofile'),
        'hermesProfilePath'
      );
      assert(artifacts.nativeStatus === 'success', describe(artifacts));
      assert(
        artifacts.nativeProfilePath?.endsWith('/native.perfetto-trace'),
        'nativeProfilePath'
      );
      assert(artifacts.downloadUris?.length === 3, describe(artifacts));
      return `${artifacts.sessionId} ${describe(artifacts)}`;
    },
  },
  {
    id: 'API-07 stop(false) keeps files private',
    run: async () => {
      const artifacts = await record({ durationMs: 5000 }, 500, false);
      assert(artifacts.downloadUris?.length === 0, describe(artifacts));
      return describe(artifacts);
    },
  },
  {
    id: 'API-08 double stop shares one result',
    run: async () => {
      const session = await startProfilingSession({ durationMs: 5000 });
      burn(500);
      const first = session.stop(true);
      const second = session.stop(true);
      assert(first === second, 'stop() returned different promises');
      const [a, b] = await Promise.all([first, second]);
      assert(a === b, 'stop() resolved different results');
      const third = await session.stop(true);
      assert(
        third === a,
        'stop() after completion returned a different result'
      );
      assert(a.downloadUris?.length === 3, describe(a));
      return describe(a);
    },
  },
  {
    id: 'API-09 second start is busy',
    run: async () => {
      const session = await startProfilingSession({ durationMs: 5000 });
      try {
        const error = await rejection(
          startProfilingSession({ durationMs: 5000 })
        );
        assert(error.code === 'E_BUSY', `code=${error.code} ${error.message}`);
      } finally {
        await session.stop(false);
      }
      return 'E_BUSY';
    },
  },
  {
    id: 'API-10 back-to-back sessions',
    run: async () => {
      const ids = new Set<string>();
      const statuses: string[] = [];
      for (let i = 0; i < 3; i++) {
        const artifacts = await record({ durationMs: 5000 }, 300, false);
        ids.add(artifacts.sessionId);
        statuses.push(
          `${artifacts.nativeStatus}:${artifacts.nativeError ?? ''}`
        );
      }
      assert(ids.size === 3, 'session ids repeated');
      return statuses.join(' | ');
    },
  },
  {
    id: 'API-11 invalid options reject E_OPTIONS',
    run: async () => {
      const bad: unknown[] = [0, -1, 1.5, NaN, Infinity, 2 ** 31, 'abc', null];
      const keys = [
        'durationMs',
        'samplingFrequencyHz',
        'bufferSizeKb',
        'resultTimeoutMs',
      ];
      const failures: string[] = [];
      for (const key of keys) {
        for (const value of bad) {
          try {
            const session = await startProfilingSession({
              [key]: value,
            } as any);
            failures.push(`${key}=${String(value)}:resolved`);
            // A session started unexpectedly; release it so later cases can run.
            await session.stop(false).catch(() => {});
          } catch (error: any) {
            if (error?.code !== 'E_OPTIONS')
              failures.push(
                `${key}=${String(value)}:${error?.code ?? error?.message}`
              );
          }
        }
      }
      // The module must still accept a valid request afterwards.
      const artifacts = await record({ durationMs: 5000 }, 200, false);
      assert(!failures.length, failures.join(', '));
      return `all rejected; follow-up ${describe(artifacts)}`;
    },
  },
  {
    id: 'API-12 native duration shorter than session',
    run: async () => {
      const session = await startProfilingSession({ durationMs: 1000 });
      burn(300);
      await sleep(2500);
      burn(300);
      const artifacts = await session.stop(false);
      assert(artifacts.nativeStatus === 'success', describe(artifacts));
      return describe(artifacts);
    },
  },
  {
    id: 'API-13 result timeout',
    run: async () => {
      const artifacts = await record(
        { durationMs: 5000, resultTimeoutMs: 1 },
        300,
        true
      );
      assert(artifacts.nativeStatus === 'timeout', describe(artifacts));
      assert(
        artifacts.nativeProfilePath === null,
        'native path should be null'
      );
      assert(!!artifacts.hermesProfilePath, 'missing Hermes profile');
      return describe(artifacts);
    },
  },
  {
    id: 'API-14 immediate stop',
    run: async () => {
      const startedAt = Date.now();
      const session = await startProfilingSession({ durationMs: 5000 });
      const artifacts = await session.stop(false);
      return `${describe(artifacts)} in ${Date.now() - startedAt} ms`;
    },
  },
  {
    id: 'API-16 frequency/buffer extremes',
    run: async () => {
      const results: string[] = [];
      for (const options of [
        { samplingFrequencyHz: 1 },
        { samplingFrequencyHz: 1000 },
        { bufferSizeKb: 64 },
      ]) {
        const artifacts = await record(
          { durationMs: 5000, ...options },
          500,
          false
        );
        results.push(`${JSON.stringify(options)}→${artifacts.nativeStatus}`);
      }
      return results.join(' ');
    },
  },
  {
    id: 'API-17 wrong session id',
    run: async () => {
      const error = await rejection(
        NativeModules.ReleaseProfiler.stopProfilingSession('bogus', false)
      );
      assert(error.code === 'E_SESSION', `code=${error.code}`);
      return error.code;
    },
  },
  {
    id: 'REG-01 legacy start/stop',
    run: async () => {
      startProfiling();
      burn(500);
      const path = await stopProfiling(false);
      assert(
        typeof path === 'string' && path.endsWith('.cpuprofile'),
        `path=${path}`
      );
      return path;
    },
  },
  {
    id: 'REG-02 legacy start during combined session',
    run: async () => {
      const session: ProfilingSession = await startProfilingSession({
        durationMs: 5000,
      });
      let outcome = 'no error';
      try {
        startProfiling();
      } catch (error: any) {
        outcome = `threw: ${error?.message}`;
      }
      const artifacts = await session.stop(false);
      assert(
        outcome !== 'no error',
        'legacy start was accepted during a combined session'
      );
      assert(artifacts.hermesProfilePath, 'combined session did not complete');
      return outcome;
    },
  },
  {
    id: 'REG-03 combined start during legacy',
    run: async () => {
      startProfiling();
      try {
        const error = await rejection(
          startProfilingSession({ durationMs: 5000 })
        );
        assert(error.code === 'E_BUSY', `code=${error.code}`);
      } finally {
        await stopProfiling(false);
      }
      return 'E_BUSY';
    },
  },
  {
    id: 'REG-04 legacy stop without start',
    run: async () => {
      try {
        return `resolved ${await stopProfiling(false)}`;
      } catch (error: any) {
        return `rejected ${error?.code} ${error?.message}`;
      }
    },
  },
];

export async function runSessionTestSuite(onProgress: (line: string) => void) {
  const results: Result[] = [];
  for (const testCase of cases) {
    onProgress(`Running ${testCase.id}…`);
    let result: Result;
    try {
      result = { id: testCase.id, pass: true, detail: await testCase.run() };
    } catch (error: any) {
      result = {
        id: testCase.id,
        pass: false,
        detail: String(error?.message ?? error),
      };
    }
    results.push(result);
    console.log(
      `[RPTEST] ${result.pass ? 'PASS' : 'FAIL'} ${result.id} :: ${
        result.detail
      }`
    );
    await sleep(300);
  }
  const failed = results.filter((result) => !result.pass).length;
  console.log(
    `[RPTEST] DONE ${results.length - failed}/${results.length} passed`
  );
  onProgress(`Suite done: ${results.length - failed}/${results.length} passed`);
  return results;
}
