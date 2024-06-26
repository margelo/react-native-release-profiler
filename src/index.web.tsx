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

const NOT_STARTED_PROFILER = {
  stop: (): Promise<ProfilingTrace> => {
    console.warn('The profiler has not been started');

    return Promise.resolve({
      frames: [],
      resources: [],
      samples: [],
      stacks: [],
    });
  },
};
let profiler = NOT_STARTED_PROFILER;

const SAMPLING_INTERVAL = 10;
const MAX_BUFFER_SIZE = 10000;
const MICRO_SECONDS_IN_MILLISECONDS = 1000;

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

export async function stopProfiling(saveToDownloads = false): Promise<string> {
  const trace = await profiler.stop();

  profiler = NOT_STARTED_PROFILER;

  const fileName = `trace-${new Date().toISOString()}`;
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
  downloadAnchorNode.setAttribute('download', exportName + '.cpuprofile.txt');
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
