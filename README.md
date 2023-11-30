# react-native-release-profiler

Use Hermes profiler even in release builds

## Installation

```sh
npm install react-native-release-profiler 
or
yarn add react-native-release-profiler
```

## Usage

1. Install the library `yarn add react-native-release-profiler`
2. Add debuggable flag to Android (REMEMBER TO REMOVE IT BEFORE RELEASING THE APP)
   ```
       <manifest xmlns:android="http://schemas.android.com/apk/res/android"
        ...
        <application android:icon="@drawable/icon"
            android:debuggable="true"
   ```
3. Build the app in release mode
4. start profling 
   ```
   import { startProfiling } from 'react-native-release-profiler';

   startProfiling()
   ```
5. stop profiling
   ```
   import { stopProfiling } from 'react-native-release-profiler';

   stopProfiling()
   ```
6. Fetch and process the profile `npx react-native profile-hermes [destinationDir] --appId [your appId]`
7. Open the profile in chrome://tracing


## Contributing

See the [contributing guide](CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
