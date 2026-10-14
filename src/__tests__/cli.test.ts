import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../pullMerge', () => ({
  pullSession: jest.fn(),
  pullMerge: jest.fn(),
}));
jest.mock('../analyze', () => ({
  ...jest.requireActual('../analyze'),
  analyze: jest.fn(),
  renderAnalysis: jest.fn(() => '# Profile analysis\n'),
}));
jest.mock('../mergeProfiles', () => ({
  ...jest.requireActual('../mergeProfiles'),
  mergeSession: jest.fn(),
}));

interface Mocks {
  pullSession: jest.Mock;
  analyze: jest.Mock;
  mergeSession: jest.Mock;
}

/** Run the CLI in-process with `--json` and return its single JSON line. */
async function runCli(args: string[], setup?: (mocks: Mocks) => void) {
  const out: string[] = [];
  const write = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
  const argv = process.argv;
  process.argv = ['node', 'cli.js', ...args, '--json'];
  let mocks!: Mocks;
  try {
    jest.isolateModules(() => {
      mocks = {
        pullSession: require('../pullMerge').pullSession,
        analyze: require('../analyze').analyze,
        mergeSession: require('../mergeProfiles').mergeSession,
      };
      setup?.(mocks);
      require('../cli');
    });
    for (let i = 0; i < 400 && !out.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    write.mockRestore();
    process.argv = argv;
    process.exitCode = undefined;
  }
  return { output: JSON.parse(out.join('')), mocks };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cli-'));
const file = (name: string, content: string) => {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};
const map = file(
  'release.map',
  JSON.stringify({ version: 3, sources: [], names: [], mappings: '' })
);
const session = path.join(dir, 'session');
file(
  'session/session.json',
  JSON.stringify({
    version: 1,
    sessionId: 's',
    pid: 1,
    hermesClock: 'monotonic',
    hermesProfilePath: '/sdcard/x/hermes.cpuprofile',
    nativeProfilePath: '/sdcard/x/native.perfetto-trace',
    nativeStatus: 'success',
    clockAnchors: [],
  })
);
const hermes = file('session/hermes.cpuprofile', '{"original":true}');
const report = (functions: number) => ({
  version: 1,
  session: { id: 'a', packageName: 'com.app' },
  quality: { jsIntervalMs: { median: 10, p95: 10 } },
  js: {
    windowMs: 1000,
    busyMs: 500,
    gcMs: 0,
    longTasks: [],
    topFunctions: Array.from({ length: functions }, (_, i) => ({
      function: `f${i}`,
      location: `src/a.ts:${i}`,
      selfMs: 100 * (i + 1),
    })),
  },
});

describe('analyze --pull', () => {
  it('checks the source map before pulling anything from the device', async () => {
    for (const sourceMap of [path.join(dir, 'typo.map'), hermes, dir]) {
      const { output, mocks } = await runCli([
        'analyze',
        '--pull',
        '--sourcemap-path',
        sourceMap,
      ]);
      expect(output.error.code).toBe('E_USAGE');
      expect(mocks.pullSession).not.toHaveBeenCalled();
    }
  });

  it('reports where the pulled session was saved', async () => {
    const pulled = path.join(dir, 'pulled');
    const { output, mocks } = await runCli(
      ['analyze', '--pull', '--sourcemap-path', map],
      (m) => {
        m.pullSession.mockReturnValue({ sessionId: 's', directory: pulled });
        m.analyze.mockResolvedValue(report(1));
      }
    );
    expect(output.ok).toBe(true);
    expect(output.result.sessionDirectory).toBe(pulled);
    expect(mocks.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ session: path.join(pulled, 'session.json') })
    );
  });

  it('reports where the pulled session was saved when analysis then fails', async () => {
    const pulled = path.join(dir, 'pulled');
    const { output } = await runCli(
      ['analyze', '--pull', '--sourcemap-path', map],
      (m) => {
        m.pullSession.mockReturnValue({ sessionId: 's', directory: pulled });
        // The CLI's own (isolated) error class, so `instanceof` holds.
        const { ProfilerError } = require('../errors');
        m.analyze.mockRejectedValue(
          new ProfilerError('E_SOURCEMAP_MISMATCH', 'other build')
        );
      }
    );
    expect(output.error).toEqual({
      code: 'E_SOURCEMAP_MISMATCH',
      message: 'other build',
      sessionDirectory: pulled,
    });
  });
});

describe('analyze arguments', () => {
  it.each([
    ['--long-task', '50ms'],
    ['--long-task', '0'],
    ['--top', 'abc'],
    ['--top', '-1'],
  ])('rejects %s %s with E_USAGE', async (flag, value) => {
    const { output, mocks } = await runCli([
      'analyze',
      session,
      '--sourcemap-path',
      map,
      flag,
      value,
    ]);
    expect(output.error.code).toBe('E_USAGE');
    expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it('passes valid numbers through', async () => {
    const { mocks } = await runCli(
      [
        'analyze',
        session,
        '--sourcemap-path',
        map,
        '--long-task',
        '16.7',
        '--top',
        '5',
      ],
      (m) => m.analyze.mockResolvedValue(report(1))
    );
    expect(mocks.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        session: path.join(session, 'session.json'),
        longTaskMs: 16.7,
        top: 5,
      })
    );
  });

  it.each(['hermes.cpuprofile', 'session.json', 'native.perfetto-trace'])(
    'refuses --output that would overwrite the session’s %s',
    async (name) => {
      const { output, mocks } = await runCli([
        'analyze',
        session,
        '--sourcemap-path',
        map,
        '--output',
        path.join(session, name),
      ]);
      expect(output.error.code).toBe('E_OUTPUT_CONFLICT');
      expect(mocks.analyze).not.toHaveBeenCalled();
      expect(fs.readFileSync(hermes, 'utf8')).toBe('{"original":true}');
    }
  );

  it('refuses --output that would overwrite the source map or --profile', async () => {
    for (const args of [
      ['--sourcemap-path', map, '--output', map],
      ['--profile', hermes, '--sourcemap-path', map, '--output', hermes],
    ]) {
      const { output } = await runCli(['analyze', ...args]);
      expect(output.error.code).toBe('E_OUTPUT_CONFLICT');
    }
  });

  it('keeps unexpected failures as E_UNKNOWN', async () => {
    const { output } = await runCli(
      ['analyze', session, '--sourcemap-path', map],
      (m) => m.analyze.mockRejectedValue(new TypeError('bug'))
    );
    expect(output.error).toEqual({ code: 'E_UNKNOWN', message: 'bug' });
  });
});

describe('compare', () => {
  it('accepts --top', async () => {
    const before = file('before.json', JSON.stringify(report(5)));
    const after = file(
      'after.json',
      JSON.stringify({ ok: true, command: 'analyze', result: report(5) })
    );
    const { output } = await runCli(['compare', before, after, '--top', '3']);
    expect(output.ok).toBe(true);
    expect(output.result.functions).toHaveLength(3);
  });

  it('rejects inputs that are not analyze reports with E_USAGE', async () => {
    const failed = file(
      'failed.json',
      JSON.stringify({ ok: false, error: { code: 'E_USAGE', message: 'x' } })
    );
    for (const input of [path.join(dir, 'nope.json'), failed, map]) {
      const { output } = await runCli(['compare', input, input]);
      expect(output.error.code).toBe('E_USAGE');
    }
  });
});

describe('--merge-session', () => {
  it('accepts the session directory', async () => {
    const { output, mocks } = await runCli(
      [
        '--merge-session',
        session,
        '--sourcemap-path',
        map,
        '--output',
        path.join(dir, 'out', 'merged.trace'),
      ],
      (m) =>
        m.mergeSession.mockResolvedValue({
          output: 'merged.trace',
          skippedSamples: {},
          overlappingNativeSamples: 1,
          nativeRecordsLost: 0,
          unmappedFrames: 0,
        })
    );
    expect(output.ok).toBe(true);
    expect(mocks.mergeSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: path.join(session, 'session.json') })
    );
  });

  it('rejects a missing source map or session with E_USAGE', async () => {
    for (const args of [
      ['--merge-session', session, '--sourcemap-path', path.join(dir, 'x')],
      ['--merge-session', path.join(dir, 'nope'), '--sourcemap-path', map],
      ['--merge-session', session, '--sourcemap-path', map, '--output', dir],
    ]) {
      const { output, mocks } = await runCli(args);
      expect(output.error.code).toBe('E_USAGE');
      expect(mocks.mergeSession).not.toHaveBeenCalled();
    }
  });
});

it('install-skill reports an unwritable target as E_USAGE', async () => {
  const { output } = await runCli(['install-skill', path.join(map, 'skills')]);
  expect(output.error.code).toBe('E_USAGE');
});
