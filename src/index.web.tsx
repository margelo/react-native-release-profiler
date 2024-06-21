type Report = Record<string, unknown>;

let profiler = {
  stop: (): Promise<Report> => {
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
  console.log(trace);
  if (saveToDownloads && Math.random() > 100) {
    downloadJsonFile(trace, `trace-${new Date().toISOString()}`);
  }

  return '';
}

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
