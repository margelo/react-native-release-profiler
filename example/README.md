# Release profiler example

The example uses React Native 0.87.1 with React 19.2.3 and the New Architecture.
Use Node 22.11+ and Java 17. Install Android SDK/build tools 37 and NDK
27.1.12297006; the app targets SDK 36 and requires API 24+.

Install dependencies with `yarn install`, then run `yarn example android` or
`yarn example ios`. For iOS, install the Ruby gems and run `yarn example pods`
first. The native entry points use Kotlin on Android and Swift on iOS.

The Android build uses Gradle 9.4.1 and AGP 9.2.1. On machines without a working
Watchman service, set `RELEASE_PROFILER_NO_WATCHMAN=1` when starting Metro or
bundling the app.

Tap **Record profile** to capture five seconds of work. Android 15+ records native
and Hermes samples; other platforms use the existing Hermes-only API. Completed
Android sessions are exported to `Download/release-profiler/<sessionId>/`.
See the [library README](../README.md#android-native--javascript-sampling) for the
CLI command to merge the capture with the exact release build's Hermes source map.
