# AGENTS.md

Guidance for AI coding agents working on this repository. To *use* the profiler on an app,
follow the skill in [`skills/react-native-release-profiler/SKILL.md`](skills/react-native-release-profiler/SKILL.md).

## Layout

- `src/index.tsx` — JS API (`startProfiling`, `stopProfiling`, `startProfilingSession`).
- `src/cli.ts` — CLI entry (`pull-merge`, `analyze`, `compare`, `doctor`, `install-skill`, legacy flags).
- `src/mergeProfiles.ts`, `src/symbolicate.ts` — clock alignment, source maps, Perfetto merge.
- `src/traceSamples.ts` — Perfetto stack-sample decoder (skips bad samples, never aborts on one).
- `src/simpleperf.ts`, `src/folded.ts` — Android Studio (Simpleperf report) and folded-stack exports.
- `src/analyze.ts`, `src/compare.ts`, `src/doctor.ts` — agent-facing reports.
- `android/` — `ProfilingSession.kt` (sessions), `NativeSampler.kt` (Android 15 ProfilingManager),
  `cpp/HermesProfilerBridge.cpp` (Hermes sampling via JNI).
- `example/` — React Native app used for device testing.

## Commands

```sh
yarn install
yarn typecheck && yarn lint && yarn test   # all must pass
npx bob build                              # builds lib/; the CLI runs from lib/commonjs/cli.js
cd example/android && ./gradlew assembleRelease
```

## Conventions

- Throw `ProfilerError` with a code from `src/errors.ts` for anything a user or agent can act on;
  add new codes there and to the skill's error table.
- Keep exports stable: refactors must produce byte-identical Simpleperf/Perfetto output for the
  same input (compare against a previous build's output).
- Native samples are untrusted input: skip and count bad samples rather than failing the capture.
- Sampled results are approximate (±1 sampling interval); don't add checks tighter than that.
- Test on a real Android 15+ device for anything touching `android/`; Android rate-limits
  stack sampling (see the README "Limits and caveats").
