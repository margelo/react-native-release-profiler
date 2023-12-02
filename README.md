# react-native-release-profiler

Use Hermes profiler even in release builds

## Installation

```sh
npm install react-native-release-profiler 
or
yarn add react-native-release-profiler
```

## Usage (Android)

1. Install the library `yarn add react-native-release-profiler`
2. Build the app in release mode
3. start profling 
   ```
   import { startProfiling } from 'react-native-release-profiler';

   startProfiling()
   ```
4. stop profiling
   ```
   import { stopProfiling } from 'react-native-release-profiler';

   stopProfiling(true)
   ```
5. Fetch and process the profile `npx react-native-release-profiler --fromDownload --appId [your appId]`
6. Open the profile in chrome://tracing

## Usage (iOS)

1. Install the library `yarn add react-native-release-profiler`
2. Build the app in release mode
3. start profling 
   ```
   import { startProfiling } from 'react-native-release-profiler';

   startProfiling()
   ```
4. stop profiling
   ```
   import { stopProfiling } from 'react-native-release-profiler';

   stopProfiling(true)
   ```
5. Send file from phone to your mac (It's in Downloads directory)
6. process the profile `npx react-native-release-profiler --local <path to profile> --appId [your appId]`
7. Open the profile in chrome://tracing


## Contributing

See the [contributing guide](CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
