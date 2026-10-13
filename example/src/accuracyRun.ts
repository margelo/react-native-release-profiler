import { NativeModules } from 'react-native';
import { startProfilingSession } from 'react-native-release-profiler';

// Ground-truth workload for accuracy checks (TEST_PLAN_rp-2.0.md §5). Each task records its
// CLOCK_MONOTONIC start/end via the example-only TestClock module and is logged as
// `[RPACC] {...}` so host scripts can compare samples against real execution windows.

const clock = (): string => NativeModules.TestClock.monotonicNs();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function accMath(ms: number) {
  const deadline = performance.now() + ms;
  let value = 0;
  while (performance.now() < deadline) {
    for (let i = 1; i < 2000; i++) value += Math.sqrt(i) * Math.sin(i);
  }
  return value;
}

function accSort(ms: number) {
  const deadline = performance.now() + ms;
  let value = 0;
  while (performance.now() < deadline) {
    const items = Array.from({ length: 2000 }, (_, i) => Math.cos(i * 31));
    items.sort((a, b) => a - b);
    value += items[0] ?? 0;
  }
  return value;
}

const payload = JSON.stringify(
  Array.from({ length: 500 }, (_, id) => ({
    id,
    label: `row ${id}`,
    v: [id, id * 2],
  }))
);

function accJson(ms: number) {
  const deadline = performance.now() + ms;
  let value = 0;
  while (performance.now() < deadline) {
    value += JSON.stringify(JSON.parse(payload)).length;
  }
  return value;
}

function accNestedInner(ms: number) {
  const deadline = performance.now() + ms;
  let value = 0;
  while (performance.now() < deadline) {
    for (let i = 1; i < 2000; i++) value += (i * 7) % 13;
  }
  return value;
}

type Window = { name: string; startNs: string; endNs: string };

function accNestedOuter(ms: number, windows: Window[]) {
  const deadline = performance.now() + ms / 2;
  let value = 0;
  while (performance.now() < deadline) {
    for (let i = 1; i < 2000; i++) value += (i * 3) % 11;
  }
  const startNs = clock();
  value += accNestedInner(ms / 2);
  windows.push({ name: 'accNestedInner', startNs, endNs: clock() });
  return value;
}

const schedule: Array<[string, number, number]> = [
  // [task, busy ms, idle ms after]
  ['accMath', 120, 250],
  ['accSort', 250, 180],
  ['accJson', 400, 420],
  ['accNestedOuter', 300, 200],
  ['accMath', 60, 330],
  ['accSort', 30, 150],
  ['accJson', 180, 500],
  ['accMath', 300, 260],
  ['accNestedOuter', 200, 210],
  ['accSort', 90, 380],
  ['accJson', 50, 240],
  ['accMath', 15, 300],
];

export async function runAccuracyCapture(
  samplingFrequencyHz: number,
  onProgress: (line: string) => void
) {
  const session = await startProfilingSession({
    durationMs: 15000,
    samplingFrequencyHz,
  });
  const windows: Window[] = [];
  const sessionStartNs = clock();
  onProgress(`Accuracy capture @${samplingFrequencyHz} Hz running…`);
  await sleep(300);
  for (const [name, busy, idle] of schedule) {
    const startNs = clock();
    if (name === 'accMath') accMath(busy);
    else if (name === 'accSort') accSort(busy);
    else if (name === 'accJson') accJson(busy);
    else accNestedOuter(busy, windows);
    windows.push({ name, startNs, endNs: clock() });
    await sleep(idle);
  }
  const sessionEndNs = clock();
  const artifacts = await session.stop(true);
  const report = {
    sessionId: artifacts.sessionId,
    samplingFrequencyHz,
    jsThreadId: NativeModules.TestClock.threadId(),
    sessionStartNs,
    sessionEndNs,
    nativeStatus: artifacts.nativeStatus,
    nativeError: artifacts.nativeError,
    windows,
  };
  console.log(`[RPACC] ${JSON.stringify(report)}`);
  onProgress(
    `Accuracy ${artifacts.sessionId}\nNative: ${artifacts.nativeStatus}` +
      (artifacts.nativeError ? `\n${artifacts.nativeError}` : '')
  );
  return report;
}
