type ProfilerOptions = {
  sampleInterval: number;
  maxBufferSize: number;
};

type Profiler = {
  new (options: ProfilerOptions): Profiler;
  stop(): Promise<ProfilingTrace>;
};

declare global {
  const Profiler: Profiler;
  interface Window {
    Profiler: Profiler;
  }
}

type Sample = {
  stackId?: number;
  timestamp: number;
};
type Stack = {
  frameId: number;
  parentId?: number;
};
type Frame = {
  name: string;
  line?: number;
  column?: number;
  resourceId?: number;
};
type ProfilingTrace = {
  frames: Frame[];
  resources: string[];
  samples: Sample[];
  stacks: Stack[];
};

let profiler: { stop(): Promise<ProfilingTrace> } | null = null;

const SAMPLING_INTERVAL = 10;
const MAX_BUFFER_SIZE = 10000;
const MICRO_SECONDS_IN_MILLISECONDS = 1000;

export type {
  ProfilingSessionOptions,
  ProfilingSessionArtifacts,
  ProfilingSession,
} from './index';

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Native sampling is only available on Android 15 and newer: rejects with `E_UNSUPPORTED`. */
export async function startProfilingSession(
  _options: import('./index').ProfilingSessionOptions = {}
): Promise<import('./index').ProfilingSession> {
  throw codedError(
    'E_UNSUPPORTED',
    'Native sampling requires Android 15 (API 35) or newer.'
  );
}

export function startProfiling(): boolean {
  if (typeof window.Profiler !== 'function') {
    console.warn(
      'Profiler is not available in this browser. Ignoring this profiler run...'
    );

    return false;
  }

  profiler = new Profiler({
    sampleInterval: SAMPLING_INTERVAL,
    maxBufferSize: MAX_BUFFER_SIZE,
  });

  return true;
}

export async function stopProfiling(
  saveToDownloads = false,
  fileName = `trace-${new Date().toISOString()}.cpuprofile.txt`
): Promise<string> {
  if (!profiler) {
    // Don't download an empty trace that looks like a real capture.
    throw codedError(
      'E_NOT_STARTED',
      'stopProfiling() was called without startProfiling(); nothing was recorded.'
    );
  }
  const trace = await profiler.stop();

  profiler = null;

  const hermesProfiler = convertToHermesProfilerFormat(trace);

  downloadJsonFile(hermesProfiler, fileName);

  if (!saveToDownloads) {
    console.warn(
      'Specifying `saveToDownloads=false` is not supported on web, as downloading is the only one possible way to store the trace file'
    );
  }

  return fileName;
}

function downloadJsonFile(
  exportObj: Record<string, unknown>,
  exportName: string
) {
  const dataStr =
    'data:text/json;charset=utf-8,' +
    encodeURIComponent(JSON.stringify(exportObj));
  const downloadAnchorNode = document.createElement('a');

  downloadAnchorNode.setAttribute('href', dataStr);
  downloadAnchorNode.setAttribute('download', exportName);
  document.body.appendChild(downloadAnchorNode); // required for Firefox
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

function convertToHermesProfilerFormat(profilingTrace: ProfilingTrace) {
  const { frames, resources, samples, stacks } = profilingTrace;

  return {
    traceEvents: [],
    samples: samples.map((sample) => ({
      cpu: '-1',
      name: '',
      ts: sample.timestamp * MICRO_SECONDS_IN_MILLISECONDS,
      pid: 1,
      tid: '1',
      weight: '1',
      sf: sample.stackId ?? 1,
    })),
    stackFrames: stacks.map((stack) => {
      const resourceId = frames[stack.frameId]?.resourceId;

      return {
        parent: stack.parentId,
        category: 'JavaScript',
        ...frames[stack.frameId],
        name: `${frames[stack.frameId]?.name}(${
          resourceId ? resources[resourceId] : null
        })`,
      };
    }),
  };
}
