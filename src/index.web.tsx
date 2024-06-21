let profiler = {
  stop: (): Promise<ProfilingTrace> => {
    throw new Error('The profiler has not been started');
  },
};

export function startProfiling(): boolean {
  // @ts-expect-error Profiler type is not available in RN context
  profiler = new Profiler({ sampleInterval: 10, maxBufferSize: 10000 });
  return true;
}

export async function stopProfiling(saveToDownloads = false): Promise<string> {
  const trace = await profiler.stop();

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
  samples.forEach((sample) => {
    const stack = sample.stackId ? stacks[sample.stackId] : undefined;
    let currentStack = stack;
    while (currentStack) {
      const frame = frameResourceMap[currentStack.frameId];
      traceEvents.push({
        pid: 1, // Process ID
        tid: 1, // Thread ID
        ts: sample.timestamp * 1000, // Convert to microseconds
        ph: 'X', // Complete event
        name: frame?.name ?? 'anonymous',
        cat: 'function',
        dur: 0, // Duration, we'll adjust this later
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

  // Calculate duration for each event
  traceEvents.sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < traceEvents.length - 1; i++) {
    // @ts-expect-error object can not be undefined because we iterate through defined array
    traceEvents[i].dur = traceEvents[i + 1].ts - traceEvents[i].ts;
  }

  return {
    traceEvents,
  };
}
