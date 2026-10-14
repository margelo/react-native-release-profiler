# `analyze` report fields

`analyze --json` → `result`; `analyze --output report.json` writes the same object.
Times are milliseconds; `startMs` is relative to the first JS sample.

## `session`
`id`, `packageName`, `pid`, `androidApiLevel`, `nativeStatus` (`success` | `error` | `timeout`),
`nativeError`. All `null` for a JS-only `--profile`.

## `quality`
| field | meaning |
|---|---|
| `jsSamples`, `jsIntervalMs.median/p95` | Hermes samples and spacing (~10 ms). Fewer than ~50 samples → record longer |
| `nativeSamples` | Native stack samples for the app process |
| `requestedFrequencyHz` / `nativeFrequencyHz` | Requested vs. effective native rate (Android may clamp) |
| `nativeRecordsLost` | Records the kernel dropped; native counts are a lower bound |
| `skippedNativeSamples` | Malformed native samples skipped, by reason |
| `overlappingNativeSamples` | Native samples inside the JS window; 0 = native and JS don't overlap |
| `symbolicatedFrames` / `unmappedFrames` | JS frames resolved / not resolved by the source map |
| `warnings` | Human-readable problems; read first |

## `js`
| field | meaning |
|---|---|
| `windowMs`, `busyMs`, `idleMs`, `gcMs` | JS thread time split; idle = only `[root]` on the stack |
| `topFunctions[]` | `function`, `location` (`file:line` where it is defined), `selfMs` (incl. builtins it calls directly), `totalMs` (anywhere on the stack), `selfPct`/`totalPct` of busy time, `samples`, `hotLines[]` (statements by self time), `lineUnknownMs` (self time with no recorded line), `code` (source around the hottest line) |
| `topLeafFrames[]` | What was literally executing: JS frames or builtins like `[Native] jsonParse` |
| `longTasks[]` | Busy stretches ≥ the threshold: `startMs`, `durationMs`, `samples`, `topFunctions[]` (`function`, `location`, `hotLine`, `ms`), `heaviestStack` (outermost first), `nativeOnJsThread[]` (`frame`, `library`, `samples`) |

## `native`
| field | meaning |
|---|---|
| `jsThreadId` | Thread running Hermes |
| `threads[]` | Samples per thread (`label`: `JS thread`, `main`, `thread`) |
| `libraries[]` | Samples per library of the leaf frame |
| `topFrames[]`, `jsThreadTopFrames[]` | Hottest native leaf frames (`0x…` = stripped symbol) |

# `compare` result
`busyMs`, `gcMs`, `longTasks.count/totalMs/maxMs` and `functions[]`, each with
`before`, `after`, `delta` and `significant` (false = within sampling noise: ~2 standard
deviations of the sample count, or under 10%). `warnings` flags different apps or very
different recording lengths.

# `doctor` result
`checks[]`: `check`, `status` (`ok` | `warn` | `fail`), `detail`, `fix`.

# Frame name glossary

| name | meaning |
|---|---|
| `[root]` | Bottom of every stack; a sample with only `[root]` is idle time |
| `[Native] x` | Hermes builtin implemented in C++ (`jsonParse`, `jsonStringify`, `arrayPrototypeSort`, `arrayFrom`, …); its time counts towards the calling JS function |
| `[HostFunction] x` | JSI host function implemented natively by React Native or a module (`now` = `performance.now()`, native module calls) |
| `[GC …]` | Garbage collection; reduce allocations to cut it |
| `?anon_0_`, `(anonymous)` | Compiler-generated or unnamed functions (async function bodies, arrow callbacks); identify them by `location` |
| `runContextFunc1Arg` and similar | Hermes runtime helper frames (e.g. calling `Math.*` or callbacks from native code); treat as time in the calling JS function |
| `(anonymous) [unmapped JS]` | JS the source map doesn't cover, usually the bundle's top-level code |
| `0x…` (native) | Address in a stripped library; classify by the library name |
