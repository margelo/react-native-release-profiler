import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertOutputIsNotInput,
  checkSourceMapFile,
  positiveNumber,
  prepareOutput,
  readReport,
  requireFile,
  sessionManifestPath,
} from '../cliInputs';
import { errorCode, ProfilerError, readInputFile } from '../errors';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp-inputs-'));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return errorCode(error);
  }
  return 'ok';
};

describe('positiveNumber (--long-task, --top)', () => {
  it('rejects typos instead of silently emptying the report', () => {
    for (const value of ['50ms', 'abc', '', ' ', '-1', '0', '0x10', '1e2'])
      expect(code(() => positiveNumber(value, '--long-task', false))).toBe(
        'E_USAGE'
      );
    for (const value of ['1.5', 'ten', '0', '-3'])
      expect(code(() => positiveNumber(value, '--top', true))).toBe('E_USAGE');
    expect(() => positiveNumber('50ms', '--long-task', false)).toThrow(
      "--long-task must be a positive number of milliseconds (got '50ms')"
    );
  });

  it('accepts positive numbers (integers for --top)', () => {
    expect(positiveNumber('50', '--long-task', false)).toBe(50);
    expect(positiveNumber('12.5', '--long-task', false)).toBe(12.5);
    expect(positiveNumber('1', '--top', true)).toBe(1);
    expect(positiveNumber('15', '--top', true)).toBe(15);
  });
});

describe('paths', () => {
  it('requires an existing, readable file', () => {
    const dir = tmp();
    const file = write(path.join(dir, 'a.map'), '{}');
    expect(requireFile(file, 'Source map')).toBe(file);
    expect(() => requireFile(path.join(dir, 'nope.map'), 'Source map')).toThrow(
      'Source map not found'
    );
    expect(() => requireFile(dir, 'Source map')).toThrow(
      'Source map is not a file'
    );
    expect(code(() => requireFile(dir, 'Profile'))).toBe('E_USAGE');
  });

  it('accepts session.json or its directory', () => {
    const dir = tmp();
    const manifest = write(path.join(dir, 's', 'session.json'), '{}');
    expect(sessionManifestPath(path.join(dir, 's'))).toBe(manifest);
    expect(sessionManifestPath(manifest)).toBe(manifest);
    expect(code(() => sessionManifestPath(path.join(dir, 'nope')))).toBe(
      'E_USAGE'
    );
    expect(() => sessionManifestPath(dir)).toThrow('no session.json');
  });

  it('checks a source map before anything is pulled from the device', () => {
    const dir = tmp();
    const profile = write(
      path.join(dir, 'hermes.cpuprofile'),
      JSON.stringify({ traceEvents: [], samples: [], stackFrames: {} })
    );
    expect(code(() => checkSourceMapFile(profile))).toBe('E_USAGE');
    expect(
      code(() =>
        checkSourceMapFile(write(path.join(dir, 'trace'), '\nV2O\u0010'))
      )
    ).toBe('E_USAGE');
    expect(
      code(() =>
        checkSourceMapFile(
          write(
            path.join(dir, 'ok.map'),
            '{"version":3,"sources":[],"names":[],"mappings":""}'
          )
        )
      )
    ).toBe('ok');
  });
});

describe('outputs', () => {
  it('creates missing directories and rejects directories or paths under a file', () => {
    const dir = tmp();
    prepareOutput(path.join(dir, 'new', 'report.md'));
    expect(fs.statSync(path.join(dir, 'new')).isDirectory()).toBe(true);
    expect(() => prepareOutput(dir)).toThrow('is a directory');
    const file = write(path.join(dir, 'file'), '');
    expect(code(() => prepareOutput(path.join(file, 'x.json')))).toBe(
      'E_USAGE'
    );
  });

  it('refuses to overwrite an input, also through a symlink', () => {
    const dir = tmp();
    const hermes = write(path.join(dir, 'hermes.cpuprofile'), '{}');
    fs.symlinkSync(hermes, path.join(dir, 'link.md'));
    expect(code(() => assertOutputIsNotInput(hermes, [hermes]))).toBe(
      'E_OUTPUT_CONFLICT'
    );
    expect(
      code(() =>
        assertOutputIsNotInput(
          path.join(dir, '..', path.basename(dir), 'hermes.cpuprofile'),
          [hermes]
        )
      )
    ).toBe('E_OUTPUT_CONFLICT');
    expect(
      code(() => assertOutputIsNotInput(path.join(dir, 'link.md'), [hermes]))
    ).toBe('E_OUTPUT_CONFLICT');
    expect(
      code(() =>
        assertOutputIsNotInput(path.join(dir, 'report.md'), [hermes, null])
      )
    ).toBe('ok');
  });
});

describe('readReport (compare inputs)', () => {
  const report = {
    version: 1,
    session: { id: 'a', packageName: 'com.app' },
    quality: { jsIntervalMs: { median: 10, p95: 12 } },
    js: { windowMs: 100, busyMs: 50, gcMs: 0, topFunctions: [], longTasks: [] },
  };

  it('accepts reports and --json envelopes', () => {
    const dir = tmp();
    expect(
      readReport(write(path.join(dir, 'r.json'), JSON.stringify(report)))
    ).toEqual(report);
    expect(
      readReport(
        write(
          path.join(dir, 'e.json'),
          JSON.stringify({ ok: true, command: 'analyze', result: report })
        )
      )
    ).toEqual(report);
  });

  it('rejects missing files, Markdown, failed results and other JSON with E_USAGE', () => {
    const dir = tmp();
    expect(() => readReport(path.join(dir, 'nope.json'))).toThrow(
      'Report not found'
    );
    expect(() =>
      readReport(write(path.join(dir, 'r.md'), '# Profile analysis'))
    ).toThrow('is not JSON');
    expect(() =>
      readReport(
        write(
          path.join(dir, 'failed.json'),
          JSON.stringify({
            ok: false,
            error: { code: 'E_USAGE', message: 'Session not found: x' },
          })
        )
      )
    ).toThrow('holds a failed command (E_USAGE: Session not found: x)');
    for (const other of [
      { ok: true, command: 'compare', result: {} },
      { ...report, js: { ...report.js, topFunctions: undefined } },
      null,
    ])
      expect(
        code(() =>
          readReport(write(path.join(dir, 'x.json'), JSON.stringify(other)))
        )
      ).toBe('E_USAGE');
    expect(code(() => readReport(dir))).toBe('E_USAGE');
  });
});

describe('errors', () => {
  it('maps ProfilerErrors and commander errors, and nothing else, to codes', () => {
    expect(errorCode(new ProfilerError('E_HERMES_PROFILE', 'x'))).toBe(
      'E_HERMES_PROFILE'
    );
    expect(errorCode({ code: 'commander.unknownOption' })).toBe('E_USAGE');
    expect(errorCode(new TypeError('bug'))).toBe('E_UNKNOWN');
    expect(errorCode(null)).toBe('E_UNKNOWN');
  });

  it('reads inputs with the caller’s code and remedy', () => {
    const dir = tmp();
    expect(() =>
      readInputFile(
        path.join(dir, 'native.perfetto-trace'),
        'E_TRACE_FORMAT',
        'native trace',
        'Re-pull'
      )
    ).toThrow(
      expect.objectContaining({
        code: 'E_TRACE_FORMAT',
        message: expect.stringMatching(
          /^Cannot read native trace .*ENOENT.*Re-pull$/
        ),
      })
    );
    expect(
      readInputFile(
        write(path.join(dir, 'f'), 'x'),
        'E_USAGE',
        'f',
        ''
      ).toString()
    ).toBe('x');
  });
});
