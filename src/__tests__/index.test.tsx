type Native = {
  startProfiling: jest.Mock;
  stopProfiling: jest.Mock;
  startProfilingSession: jest.Mock;
  stopProfilingSession: jest.Mock;
};

function load(platform: { OS: string; Version: number | string }) {
  const native: Native = {
    startProfiling: jest.fn(() => true),
    stopProfiling: jest.fn(),
    startProfilingSession: jest.fn(),
    stopProfilingSession: jest.fn(),
  };
  jest.resetModules();
  jest.doMock('react-native', () => ({
    NativeModules: { ReleaseProfiler: native },
    Platform: { ...platform, select: () => '' },
    PermissionsAndroid: { request: jest.fn(), PERMISSIONS: {} },
  }));
  const api = require('../index') as typeof import('../index');
  return { api, native };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.dontMock('react-native');
});

describe('startProfilingSession', () => {
  it.each([
    ['android', 34],
    ['ios', '18.0'],
  ])(
    'rejects with code E_UNSUPPORTED on %s %s without calling native',
    async (OS, Version) => {
      const { api, native } = load({ OS, Version });
      await expect(api.startProfilingSession()).rejects.toMatchObject({
        code: 'E_UNSUPPORTED',
        message: expect.stringContaining('Android 15'),
      });
      expect(native.startProfilingSession).not.toHaveBeenCalled();
    }
  );

  it('reports a fresh session as not adopted, without warnings', async () => {
    const { api, native } = load({ OS: 'android', Version: 35 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    native.startProfilingSession.mockResolvedValue({
      sessionId: 'abc',
      adopted: false,
      nativeEndedBeforeAdoption: false,
    });
    const session = await api.startProfilingSession({ durationMs: 5000 });
    expect(session).toMatchObject({
      sessionId: 'abc',
      adopted: false,
      nativeEndedBeforeAdoption: false,
    });
    expect(native.startProfilingSession).toHaveBeenCalledWith({
      durationMs: 5000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when an adopted startup recording ignores the options', async () => {
    const { api, native } = load({ OS: 'android', Version: 35 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    native.startProfilingSession.mockResolvedValue({
      sessionId: 'startup',
      adopted: true,
      nativeEndedBeforeAdoption: false,
    });
    const session = await api.startProfilingSession({
      samplingFrequencyHz: 500,
    });
    expect(session.adopted).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('options passed here were not applied')
    );
  });

  it('does not warn when adopting without options', async () => {
    const { api, native } = load({ OS: 'android', Version: 35 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    native.startProfilingSession.mockResolvedValue({
      sessionId: 'startup',
      adopted: true,
      nativeEndedBeforeAdoption: false,
    });
    await api.startProfilingSession();
    expect(warn).not.toHaveBeenCalled();
  });

  it('flags and warns when the adopted native recording already ended', async () => {
    const { api, native } = load({ OS: 'android', Version: 35 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    native.startProfilingSession.mockResolvedValue({
      sessionId: 'startup',
      adopted: true,
      nativeEndedBeforeAdoption: true,
    });
    const session = await api.startProfilingSession();
    expect(session).toMatchObject({
      adopted: true,
      nativeEndedBeforeAdoption: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /already ended.*no native samples overlap/
    );
  });

  it('passes through the native options rejection when adopting', async () => {
    const { api, native } = load({ OS: 'android', Version: 35 });
    native.startProfilingSession.mockRejectedValue(
      Object.assign(new Error('durationMs must be a positive integer'), {
        code: 'E_OPTIONS',
      })
    );
    await expect(
      api.startProfilingSession({ durationMs: -5 })
    ).rejects.toMatchObject({ code: 'E_OPTIONS' });
  });

  it('shares one stop result between repeated stop() calls', async () => {
    const { api, native } = load({ OS: 'android', Version: 35 });
    native.startProfilingSession.mockResolvedValue({
      sessionId: 'abc',
      adopted: false,
      nativeEndedBeforeAdoption: false,
    });
    const artifacts = { sessionId: 'abc', savedToDownloads: false };
    native.stopProfilingSession.mockResolvedValue(artifacts);
    const session = await api.startProfilingSession();
    const first = session.stop();
    expect(session.stop(true)).toBe(first);
    await expect(first).resolves.toBe(artifacts);
    expect(native.stopProfilingSession).toHaveBeenCalledTimes(1);
    expect(native.stopProfilingSession).toHaveBeenCalledWith('abc', false);
  });
});

describe('web', () => {
  function loadWeb() {
    jest.resetModules();
    return require('../index.web') as typeof import('../index.web');
  }

  it('startProfilingSession rejects with code E_UNSUPPORTED', async () => {
    await expect(loadWeb().startProfilingSession()).rejects.toMatchObject({
      code: 'E_UNSUPPORTED',
    });
  });

  it('stopProfiling without startProfiling rejects and downloads nothing', async () => {
    const createElement = jest.fn();
    (globalThis as any).document = { createElement, body: {} };
    try {
      await expect(loadWeb().stopProfiling(true)).rejects.toMatchObject({
        code: 'E_NOT_STARTED',
      });
      expect(createElement).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as any).document;
    }
  });

  it('stopProfiling after startProfiling downloads the trace', async () => {
    const web = loadWeb();
    const anchor = {
      setAttribute: jest.fn(),
      click: jest.fn(),
      remove: jest.fn(),
    };
    const g = globalThis as any;
    g.document = {
      createElement: jest.fn(() => anchor),
      body: { appendChild: jest.fn() },
    };
    g.window = g.window ?? g;
    const stop = jest.fn(async () => ({
      frames: [{ name: 'f' }],
      resources: [],
      samples: [{ timestamp: 1, stackId: 0 }],
      stacks: [{ frameId: 0 }],
    }));
    g.window.Profiler = g.Profiler = jest.fn(function (this: any) {
      this.stop = stop;
    });
    try {
      expect(web.startProfiling()).toBe(true);
      await expect(web.stopProfiling(true, 'trace.cpuprofile')).resolves.toBe(
        'trace.cpuprofile'
      );
      expect(anchor.click).toHaveBeenCalled();
      // The profiler is single-use: a second stop has nothing to save.
      await expect(web.stopProfiling(true)).rejects.toMatchObject({
        code: 'E_NOT_STARTED',
      });
    } finally {
      delete g.document;
      delete g.window.Profiler;
      delete g.Profiler;
    }
  });
});
