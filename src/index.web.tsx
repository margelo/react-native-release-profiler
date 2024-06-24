type Profiler = any;
declare global {
  const Profiler: Profiler;
  interface Window {
    Profiler: Profiler;
  }
}

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

  if (saveToDownloads) {
    downloadJsonFile(
      convertToTraceEventFormat(trace),
      `trace-${new Date().toISOString()}`
    );
  }

  return '';
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
type TraceEvent = {
  pid: number;
  tid: number;
  ts: number;
  ph: string;
  name: string;
  cat: string;
  dur: number;
  args:
    | {
        column: number;
        line: number;
        resource: string;
      }
    | {};
};

function downloadJsonFile(
  exportObj: Record<string, unknown>,
  exportName: string
) {
  const dataStr =
    'data:text/json;charset=utf-8,' +
    encodeURIComponent(JSON.stringify(exportObj, null, 2));
  const downloadAnchorNode = document.createElement('a');

  downloadAnchorNode.setAttribute('href', dataStr);
  downloadAnchorNode.setAttribute('download', exportName + '.json');
  document.body.appendChild(downloadAnchorNode); // required for Firefox
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

function convertToTraceEventFormat(profilingTrace: ProfilingTrace) {
  const { frames, resources, samples, stacks } = profilingTrace;
  const traceEvents: TraceEvent[] = [];

  // Map frames to their corresponding resources
  const frameResourceMap = frames.map((frame) => {
    return {
      ...frame,
      resource: frame.resourceId ? resources[frame.resourceId] : undefined,
    };
  });

  // Convert samples and stacks to trace events
  samples.forEach((sample, index) => {
    const nextSample = samples[index + 1];
    const duration = nextSample
      ? nextSample.timestamp - sample.timestamp
      : SAMPLING_INTERVAL;
    const stack = sample.stackId ? stacks[sample.stackId] : undefined;
    let currentStack = stack;
    while (currentStack) {
      const frame = frameResourceMap[currentStack.frameId];
      traceEvents.push({
        pid: 1, // Process ID
        tid: 1, // Thread ID
        ts: sample.timestamp * MICRO_SECONDS_IN_MILLISECONDS,
        ph: 'X', // Complete event
        name: frame?.name ?? 'anonymous',
        cat: 'function',
        dur: duration * MICRO_SECONDS_IN_MILLISECONDS,
        args: {
          column: frame?.column,
          line: frame?.line,
          resource: frame?.resource,
        },
      });
      currentStack = currentStack.parentId
        ? stacks[currentStack.parentId]
        : undefined;
    }
  });

  return {
    traceEvents,
  };
}
