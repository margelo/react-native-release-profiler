import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Device state for the fake `adb` (a Node script put first on PATH). */
export interface FakeDevice {
  /** `adb devices` rows; default one authorized device `SER1`. */
  devices?: { serial: string; state: string }[];
  api?: number;
  limiter?: string;
  /** Installed apps; `debuggable` controls run-as. */
  packages?: Record<string, { debuggable?: boolean; lastUpdateTime?: string }>;
  /** MediaStore owner of files directly in /sdcard/Download. */
  owners?: Record<string, string>;
  /** Android < 10 has no MediaStore Downloads collection. */
  noMediaStore?: boolean;
  /** Device clock for `date +%s` (seconds). */
  now?: number;
  /** Step to hang on / fail: version, devices, getprop, device_config, pm, dumpsys,
   * content, run-as, stat, ls, cat, pull. */
  hang?: string;
  fail?: string;
}

// The fake adb itself: plain CommonJS so it runs with any Node.
const SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = process.env.FAKE_ADB_ROOT;
const device = JSON.parse(fs.readFileSync(path.join(ROOT, 'device.json'), 'utf8'));
let argv = process.argv.slice(2);
fs.appendFileSync(path.join(ROOT, 'calls.log'), JSON.stringify(argv) + '\n');
// Synchronous writes: process.exit() would drop pending pipe writes.
const die = (message, code = 1) => { fs.writeSync(2, message + '\n'); process.exit(code); };
const step = (name) => {
  if (device.hang === name) { setTimeout(() => {}, 3600e3); return true; }
  if (device.fail === name) die('error: closed');
  return false;
};
const devices = device.devices || [{ serial: 'SER1', state: 'device' }];
let serial;
if (argv[0] === '-s') { serial = argv[1]; argv = argv.slice(2); }
const [cmd, ...rest] = argv;
if (cmd === 'version') { if (!step('version')) process.stdout.write('Android Debug Bridge version 1.0.41\n'); return; }
if (cmd === 'devices') {
  if (!step('devices'))
    process.stdout.write('List of devices attached\n' + devices.map((d) => d.serial + '\t' + d.state + '\n').join('') + '\n');
  return;
}
serial = serial || process.env.ANDROID_SERIAL;
let target;
if (serial) {
  target = devices.find((d) => d.serial === serial);
  if (!target) die("adb: device '" + serial + "' not found");
} else {
  if (!devices.length) die('adb: no devices/emulators found');
  if (devices.length > 1) die('adb: more than one device/emulator');
  target = devices[0];
}
if (target.state === 'unauthorized') die('adb: device unauthorized.');
if (target.state === 'offline') die('adb: device offline');
const sdcard = path.join(ROOT, 'sdcard');
const toHost = (s) => s.replace(/(^|[\s'"])\/sdcard/g, '$1' + sdcard);
const fromHost = (s) => s.split(sdcard).join('/sdcard');
const sh = (line, cwd, raw) => {
  const r = spawnSync('/bin/sh', ['-c', toHost(line)], {
    cwd,
    maxBuffer: Infinity,
    env: { ...process.env, PATH: path.join(ROOT, 'shims') + ':' + process.env.PATH },
  });
  if (raw) process.stdout.write(r.stdout);
  else process.stdout.write(fromHost(r.stdout.toString()));
  process.stderr.write(fromHost(r.stderr.toString()));
  process.exitCode = r.status === null ? 1 : r.status;
};
if (cmd === 'shell') {
  const line = rest.join(' ');
  const packages = device.packages || {};
  let m;
  if (line === 'getprop ro.build.version.sdk') { if (!step('getprop')) process.stdout.write((device.api || 35) + '\n'); return; }
  if (line.startsWith('device_config get')) { if (!step('device_config')) process.stdout.write((device.limiter || 'null') + '\n'); return; }
  if ((m = line.match(/^pm path (\S+)$/))) {
    if (step('pm')) return;
    if (packages[m[1]]) process.stdout.write('package:/data/app/~~x==/' + m[1] + '-y==/base.apk\n');
    else process.exitCode = 1;
    return;
  }
  if ((m = line.match(/^dumpsys package (\S+)$/))) {
    if (step('dumpsys')) return;
    const app = packages[m[1]];
    if (app) process.stdout.write('Packages:\n  Package [' + m[1] + ']:\n    lastUpdateTime=' + (app.lastUpdateTime || '2020-01-01 00:00:00') + '\n');
    return;
  }
  if (line.startsWith('content query')) {
    if (step('content')) return;
    if (device.noMediaStore) die('Error while accessing provider:media');
    const dir = path.join(sdcard, 'Download');
    const rows = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
    if (!rows.length) process.stdout.write('No result found.\n');
    rows.forEach((name, i) => process.stdout.write('Row: ' + i + ' _display_name=' + name + ', owner_package_name=' + ((device.owners || {})[name] || 'NULL') + ', relative_path=Download/\n'));
    return;
  }
  if ((m = line.match(/^run-as '?([^'\s]+)'? (.*)$/))) {
    if (step('run-as')) return;
    const app = packages[m[1]];
    if (!app) die('run-as: unknown package: ' + m[1]);
    if (!app.debuggable) die('run-as: package not debuggable: ' + m[1]);
    const home = path.join(ROOT, 'data', m[1]);
    fs.mkdirSync(home, { recursive: true });
    return sh(m[2], home, /^cat /.test(m[2]));
  }
  const name = line.includes('stat -c') ? 'stat' : line.split(/\s+/)[0];
  if (step(name)) return;
  // Toybox ls accepts options after paths (ls /dir -tp); BSD ls does not.
  if ((m = line.match(/^ls ((?:[^|;&<>]*\s)?)(-[a-zA-Z]+)$/)))
    return sh('ls ' + m[2] + ' ' + m[1], ROOT, false);
  return sh(line, ROOT, name === 'cat');
}
if (cmd === 'pull') {
  if (step('pull')) return;
  const [src, dst] = rest;
  const host = path.join(sdcard, src.replace(/^\/sdcard\//, ''));
  if (!fs.existsSync(host)) die("adb: error: failed to stat remote object '" + src + "': No such file or directory");
  if (fs.statSync(host).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(host)) fs.copyFileSync(path.join(host, name), path.join(dst, name));
  } else fs.copyFileSync(host, fs.existsSync(dst) && fs.statSync(dst).isDirectory() ? path.join(dst, path.basename(host)) : dst);
  process.stdout.write(src + ': pulled\n');
  return;
}
die('fake adb: unsupported ' + JSON.stringify(argv), 2);
`;

// Device toybox tools that macOS lacks or formats differently.
const STAT = String.raw`
const fs = require('fs');
const args = process.argv.slice(2);
const format = args[args.indexOf('-c') + 1];
const files = args.filter((a, i) => a !== '-c' && i !== args.indexOf('-c') + 1);
const pad = (n) => String(n).padStart(2, '0');
for (const file of files) {
  let st;
  try { st = fs.statSync(file); } catch { process.stderr.write("stat: '" + file + "': No such file or directory\n"); process.exitCode = 1; continue; }
  const d = st.mtime;
  const local = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.000000000 +0000';
  process.stdout.write(format.replace('%Y', String(Math.floor(st.mtimeMs / 1000))).replace('%n', file).replace('%y', local) + '\n');
}
`;
const DATE = String.raw`
const fs = require('fs');
const path = require('path');
const device = JSON.parse(fs.readFileSync(path.join(process.env.FAKE_ADB_ROOT, 'device.json'), 'utf8'));
process.stdout.write(String(device.now || Math.floor(Date.now() / 1000)) + '\n');
`;

const tempDirs: string[] = [];

/** A temp directory removed by `removeTempDirs()` (call it in afterEach). */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
}

export interface FakeAdb {
  root: string;
  /** Put the fake adb first on PATH (returns a restore function). */
  use(): () => void;
  env: Record<string, string>;
  /** Create a device file (`/sdcard/...` or `/data/<pkg>/...`), optionally with an mtime (s). */
  file(devicePath: string, content: string | Uint8Array, mtime?: number): void;
  /** adb argument lists received so far. */
  calls(): string[][];
}

export function fakeAdb(device: FakeDevice = {}): FakeAdb {
  const root = tempDir('rp-fake-adb-');
  const bin = path.join(root, 'bin');
  const shims = path.join(root, 'shims');
  fs.mkdirSync(bin);
  fs.mkdirSync(shims);
  fs.mkdirSync(path.join(root, 'sdcard', 'Download'), { recursive: true });
  fs.writeFileSync(path.join(root, 'device.json'), JSON.stringify(device));
  fs.writeFileSync(path.join(root, 'calls.log'), '');
  const script = (file: string, source: string) =>
    fs.writeFileSync(file, `#!${process.execPath}\n${source}`, {
      mode: 0o755,
    });
  script(path.join(bin, 'adb'), SCRIPT);
  script(path.join(shims, 'stat'), STAT);
  script(path.join(shims, 'date'), DATE);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_ADB_ROOT: root,
  };
  return {
    root,
    env,
    use() {
      const saved = { PATH: process.env.PATH, ROOT: process.env.FAKE_ADB_ROOT };
      Object.assign(process.env, env);
      // Never let a test reach a real adb (and a real device).
      const resolved = execFileSync('/bin/sh', ['-c', 'command -v adb'], {
        env: process.env,
        encoding: 'utf8',
      }).trim();
      if (resolved !== path.join(bin, 'adb'))
        throw new Error(`adb resolves to ${resolved}, not the fake`);
      return () => {
        process.env.PATH = saved.PATH;
        if (saved.ROOT === undefined) delete process.env.FAKE_ADB_ROOT;
        else process.env.FAKE_ADB_ROOT = saved.ROOT;
      };
    },
    file(devicePath, content, mtime) {
      // /sdcard/... and /data/<pkg>/... (the run-as home) live under the fake root.
      const host = path.join(root, devicePath.replace(/^\//, ''));
      fs.mkdirSync(path.dirname(host), { recursive: true });
      fs.writeFileSync(host, content);
      if (mtime !== undefined) fs.utimesSync(host, mtime, mtime);
    },
    calls() {
      return fs
        .readFileSync(path.join(root, 'calls.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}
