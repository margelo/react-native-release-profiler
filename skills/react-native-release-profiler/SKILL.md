---
name: react-native-release-profiler
description: Profile a React Native release build with react-native-release-profiler and find what makes it slow — JS hotspots with source lines, long JS tasks, and native (C++/Java) work on Android 15+. Use when asked to profile a React Native app, investigate jank, slow startup, slow screens or long tasks in a release build, verify that a performance fix helped (before/after comparison), or interpret a merged Hermes + native trace.
---

# React Native release profiling

`react-native-release-profiler` records Hermes JS samples in release builds and, on Android 15+,
native stack samples at the same time. Its CLI turns a recording into a report an agent can
act on. Work in this loop:

1. **Check** the environment → `doctor`
2. **Record** the slow scenario on a release build
3. **Analyze** → JS hotspots with `file:line`, long tasks, native breakdown
4. **Fix** the code the report points at
5. **Verify** → record the same scenario again and `compare`

Always pass `--json` when you will parse output: stdout is then exactly one JSON object,
`{"ok":true,"command":…,"result":…}` or `{"ok":false,"error":{"code":…,"message":…}}`.

## 1. Check the environment

```sh
npx react-native-release-profiler doctor --appId <android.package> \
  --sourcemap-path android/app/build/generated/sourcemaps/react/release/index.android.bundle.map --json
```

Each check is `ok`, `warn` or `fail` with a `fix` command. Resolve every `fail` first.
`rate-limiter: warn` matters: Android 15 allows roughly one native capture per app per hour.
For local work ask the user to run (it changes a device setting):
`adb shell device_config put profiling_testing rate_limiter.disabled true`.

## 2. Record

Profile a **release** build (debug builds run unoptimised code and mislead). The app must call
the API around the scenario. If it doesn't, add this (Android 15+; also see the README):

```ts
import { startProfilingSession } from 'react-native-release-profiler';

const session = await startProfilingSession({ durationMs: 30000 });
// …run the slow scenario…
const artifacts = await session.stop(true); // true = export to Download/release-profiler/<id>/
```

- Older Android and iOS: `startProfiling()` / `await stopProfiling(true)` record Hermes JS only.
- App startup: call `NativeProfiling.start(this)` in `Application.attachBaseContext` and adopt it
  from JS with `startProfilingSession()` (README → "Capture app startup").
- Drive the scenario reproducibly when you can (a test button, deep link, `adb shell input`,
  or an existing E2E flow) and record the same steps for before/after runs.
- Rebuild after code changes: the source map must come from the exact installed build.

## 3. Analyze

```sh
npx react-native-release-profiler analyze --pull --appId <android.package> \
  --sourcemap-path <release map> --output before.json --json
```

`--pull` downloads the latest exported session (into `--directory`, default `.`). To analyze one
already on disk: `analyze <dir-or-session.json> --sourcemap-path <map>`. For a JS-only
`.cpuprofile` (iOS, Android < 15): `analyze --profile <file> --sourcemap-path <map>`.
Without `--json` the same report prints as Markdown.

Read the report in this order (field reference: [references/report.md](references/report.md)):

1. `quality.warnings` — decide whether they affect your question. Re-record when the JS
   picture is unreliable (fewer than ~50 JS samples, `E_…` errors) or when you need native
   detail and it is missing, clamped or lossy. A few unmapped frames are normal (the bundle's
   top-level `(anonymous) [unmapped JS]` is always one).
2. `js.longTasks` — each blocks the JS thread for `durationMs` (≥ 50 ms by default).
   `topFunctions[]` gives the function (`location` = where it is defined) and `hotLine` (the
   hottest known statement in that task); `heaviestStack` shows how it was reached;
   `nativeOnJsThread` shows what the engine was doing (e.g. `fmod`/`sin` in `libm` = `%`/math,
   JSON builtins, `0x…` addresses in `libhermesvm.so` = interpreter work).
3. `js.topFunctions` — where JS time goes overall. `selfMs` includes builtins the function
   calls directly (`[Native] jsonParse`, `arrayPrototypeSort`, …), so the function is the thing
   to change. `hotLines` ranks statements inside it, but only covers the time whose line is
   known: when `lineUnknownMs` is a large share of `selfMs`, read the whole function rather than
   just the top hot line. `code` shows the source around the hottest line.
4. `js.topLeafFrames` — which builtin or function was literally executing.
5. `native` — native samples per thread (`JS thread`, `main` = UI thread, others by thread ID;
   Android doesn't record thread names) and per library.

If a function you expected is missing, Hermes probably inlined it: its time is reported under
the caller. Names like `[HostFunction] now`, `?anon_0_` or `runContextFunc1Arg` are engine
frames — see the glossary in [references/report.md](references/report.md).

Open the files at the reported `location`s before proposing changes. Paths are relative to
the working directory; if the tree has moved, use the `code` excerpt or search the repository
for the file name. Typical fixes: avoid
repeated `JSON.parse`/`stringify` of large payloads, memoize or move sorting/filtering out of
render, batch or debounce work triggered per item/event, move heavy work off the JS thread,
cut allocations that drive `[GC …]` time.

## 4. Verify the fix

Re-record the **same scenario** on the new build with its own map, then compare:

```sh
npx react-native-release-profiler analyze --pull --appId <pkg> --sourcemap-path <new map> --output after.json --json
npx react-native-release-profiler compare before.json after.json --json
```

Trust only changes with `"significant": true`; the rest is sampling noise. For decisions that
matter, record 2–3 runs of each version. Report the before/after numbers to the user.

## Other outputs

- Android Studio: `pull-merge --sourcemap-path <map>` writes `merged.trace`
  (Profiler → Past Recordings → Import recording). Bar widths there are not CPU time.
- Perfetto UI: `--format perfetto` → `merged.perfetto-trace` (ui.perfetto.dev).
- Folded stacks for grep/flamegraphs: `--format folded` → `merged.folded.txt`
  (`track;outer;…;leaf count` per line).

## Errors

| `error.code` | Meaning | Do this |
|---|---|---|
| `E_USAGE` | Missing/invalid argument or path | Fix the command (`--help`) |
| `E_ADB` | adb failed | `doctor`; check device/USB authorization; pass `--device` |
| `E_NO_SESSIONS` | Nothing exported (for `--appId`) | Record and finish with `session.stop(true)` |
| `E_BAD_SESSION_ID` | Not a session UUID | Use the ID from the app or omit it for the latest |
| `E_SESSION_MANIFEST` | `session.json` unreadable/unsupported | Re-pull; don't edit session files |
| `E_NATIVE_MISSING` | Native capture failed (message has the reason) | Rate limit → disable limiter, re-record; `analyze` still works JS-only |
| `E_NO_NATIVE_SAMPLES` | Native trace had no stack samples | Re-record; keep the app in the foreground |
| `E_WRONG_NATIVE_TRACE` | Native trace from another process/session | Re-pull the whole session directory |
| `E_CLOCK` | Device slept or clocks jumped mid-capture | Keep the screen on; re-record |
| `E_SOURCEMAP_MISMATCH` | Map is from a different build | Use the map from the exact installed build (rebuild + reinstall if unsure) |
| `E_SOURCEMAP_UNRESOLVED` | Map resolved nothing (e.g. a dev-server map for a release build) | Use the composed release map |
| `E_HERMES_PROFILE` / `E_TRACE_FORMAT` | Corrupt or truncated input | Re-pull / re-record |
| `E_OUTPUT_CONFLICT` | Output would overwrite an input | Choose another `--output` |

## Pitfalls

- **Source map must match the build.** A map from another build is rejected (`E_SOURCEMAP_MISMATCH`);
  never work around it.
- **Sampling, not tracing.** Durations are ±1 sampling interval (~10 ms for JS). Tasks shorter
  than ~20 ms are unreliable; don't optimise noise.
- **Inlining.** Hermes inlines small functions into their caller; their time appears under the
  caller.
- **Unknown lines.** Hermes doesn't record the executing line for the innermost interpreted
  frame; that time is in `lineUnknownMs` and only the function is known. Read the whole function.
- **Native names.** Release `.so` files are stripped, so many native frames are `0x…` addresses;
  use the library name (`libhermesvm.so`, `libhwui.so`, …) to classify the work.
- **Clamped frequency / lost records.** Android may lower `samplingFrequencyHz` (e.g. 1000 → 200 Hz)
  and drop records; the report says so. Native counts are then lower bounds.
- **Idle time** is `[root]`-only samples; it is not a problem by itself.
