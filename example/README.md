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

To record Android startup, build a release APK with
`cd example/android && ./gradlew assembleRelease -PprofileStartup=true`.
This requests native-only sampling before `loadReactNative(this)` in
`MainApplication`. Launch the app, then tap **Record profile** to start Hermes
sampling, adopt the native session, and export both after five more seconds.
Hermes samples begin at the button press, not at app launch. Native sampling has a
default 30-second duration; tap promptly to capture overlapping native and JS
activity. Startup profiling is disabled by default.
