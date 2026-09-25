<a href="https://margelo.io">
  <img src="./img/banner.svg" width="100%" />
</a>

# react-native-release-profiler

A fast and simple library to passively profile JS/Hermes performance in production and release builds.

## Why

Usually performance issues are profiled in debug builds, which could lead to false positives (e.g. JS Garbage Collectors, Hermes-specific debug markers, or other LLDB hangs).

**react-native-release-profiler** allows you to profile your app in release builds, both in a local environment to profile specific issues, as well as in a production environment to spot regressions or collect performance samples from a wider variety of user devices.

## Web support

The web support is based on sampling [JS Self-Profiling](https://wicg.github.io/js-self-profiling/) API, so not all browsers support it yet. To see in which browsers it is supported, check [this page](https://caniuse.com/mdn-api_profiler).

To make it possible to work you'll need to add `'Document-Policy': 'js-profiling'` header to your server response. Using `webpack` in dev mode you can do that by adding these lines to your `webpack.config.js`:

```js
devServer: {
    headers: {
        'Document-Policy': 'js-profiling',
    },
}
```

> [!WARNING]
> By default sampling interval is set to 10 milliseconds. This is the lowest supported interval, but on Windows machines this interval will be 16 milliseconds.

## Need help?

If you're having performance problems in your app, feel free to reach out to us at https://margelo.com. We do this a lot. 😉

## Installation

```sh
yarn add react-native-release-profiler
cd ios && bundle install && bundle exec pod install
```

### Expo

Expo requires you to also install @react-native-community/cli

```sh
yarn add --dev @react-native-community/cli
```

## Usage

1. Install **react-native-release-profiler**
2. Build your app in release mode
3. Start a profiling session:
    ```ts
    import { startProfiling } from 'react-native-release-profiler'

    startProfiling()
    ```
4. Stop the profiling session:
    ```ts
    import { stopProfiling } from 'react-native-release-profiler'

    // `true` to save the trace to the phone's downloads folder, `false` otherwise
    const path = await stopProfiling(true)
    ```
5. Download and process the performance trace from your phone to your PC:
    - On **Android**:
        ```
        npx react-native-release-profiler --fromDownload --appId <your appId>
        ```
    - On **iOS** and **web**:
        ```
        npx react-native-release-profiler --local <path to profile>
        ```
6. Open the performance trace in your tool of choice:
    - SpeedScope (https://www.speedscope.app)
    - Perfetto UI (https://ui.perfetto.dev/)
    - Google Chrome's Tracing UI ([chrome://tracing](chrome://tracing))

<img src="img/perfetto.png" />


## API

### Android native + JavaScript sampling

On Android 15 (API 35) and newer, record native stacks alongside Hermes with
`startProfilingSession()`. Build against Android SDK 35 or newer and use a release
build for representative measurements. No `<profileable android:shell="true" />`
manifest entry is required for the programmatic API. System-service profiling is
enabled by default; `<profileable android:enabled="false" />` disables it.
See the [Android manifest documentation](https://developer.android.com/guide/topics/manifest/profileable-element).

```ts
import { startProfilingSession } from 'react-native-release-profiler';

const session = await startProfilingSession({
  durationMs: 30000,
  samplingFrequencyHz: 100,
});

// Exercise the app, then stop and export the capture.
const artifacts = await session.stop(true);
if (artifacts.nativeStatus !== 'success') {
  console.warn(artifacts.nativeError); // The Hermes profile is still available.
}
```

Only one recording can run at a time. The existing Hermes-only API remains
available on older Android versions and other supported platforms.

#### Capture app startup

Request native sampling from `MainApplication.onCreate()` before initializing
React Native. This hook does not load the Hermes profiler bridge or start JS sampling:

```kotlin
import android.os.Build
import com.releaseprofiler.NativeProfiling

override fun onCreate() {
  super.onCreate()
  if (Build.VERSION.SDK_INT >= 35 && profilingEnabled) {
    NativeProfiling.start(this)
  }
  loadReactNative(this) // Keep your existing RN/SoLoader initialization here.
}
```

`profilingEnabled` is your own opt-in. On older React Native versions, keep your
existing `SoLoader.init(...)` instead of adding `loadReactNative(...)`.

Call `startProfilingSession()` from JS to enable Hermes sampling and adopt the
native recording, then `session.stop(true)` to export both. Native sampling is
not restarted, and the native start's options remain in effect. Without a native
startup recording, the JS call starts both collectors.

JS samples begin at the JS start call; Hermes initialization and earlier bundle
execution are not captured by the Hermes sampler. Native sampling may cover
that earlier work, but Android starts it asynchronously, so the first native
startup instructions may still be missed. Clock anchors align both recordings
in the CLI even though they start at different times.

#### Stop and merge

`startProfilingSession()` resolves when sampling is requested, not when native
sampling begins. Android starts asynchronously, may clamp settings, and applies
rate limits. `stop()` disables Hermes, requests native cancellation, and waits
for the native result. Optional `bufferSizeKb` and `resultTimeoutMs` default to
8192 KB and 120000 ms. Repeated `stop()` calls share the same result.

`stop(true)` exports `session.json`, `hermes.cpuprofile`, and, if available,
`native.perfetto-trace` into `Download/release-profiler/<sessionId>/`.
`stop()` without `true` keeps them in app-private storage. Native errors or
timeouts are reported in the artifacts; a successful Android response does not
guarantee the trace contains stack samples.

Pull the exported directory and merge it using the **composed Hermes source map
from the exact installed release build**:

```sh
adb pull /sdcard/Download/release-profiler/<sessionId> ./capture
npx react-native-release-profiler --merge-session ./capture/session.json \
  --sourcemap-path ./android/app/build/generated/sourcemaps/react/release/index.android.bundle.map \
  --output ./merged.perfetto-trace
```

Open the result in [Perfetto](https://ui.perfetto.dev/). The CLI preserves native
trace packets and adds symbolicated Hermes samples on the same timeline.
Start/stop clock anchors map Hermes' monotonic timestamps to Android's boottime
clock. Captures with clock changes (such as device suspend), mismatched process
IDs, missing native samples, or invalid timestamp coverage are rejected.
Native and JS stacks remain independent samples; they are not joined into one
call stack or converted into exact function durations.


### `startProfiling(): void`

Synchronously starts the Hermes Profiling Session.

### `stopProfiling(saveInDownloadsDirectory?: boolean, fileName?: string): Promise<string>`

Asynchronously stops the Hermes Profiling Session, and saves the file in a cache or downloads directory if `saveInDownloadsDirectory` is `true` using the provided `fileName` (web only).

Returns the path of the saved profile.

## Contributing

See the [contributing guide](CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

MIT
