# react-native-release-profiler

Finally a reliable way to profile our apps. No more false-positives or findings issues that are only present in debug build.

## Need some help with performance issues?

If have any problems with performance feel free to reach out to us at `hello@margelo.io`. We will make your app faster than any of its competitors.  

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
4. stop profiling and keep the path
   ```
   import { stopProfiling } from 'react-native-release-profiler';

   const path = stopProfiling(true)
   ```
5. Send file from phone to your mac through AirDrop
    ```
    import Share from 'react-native-share';
    const path = await stopProfiling(true)
    const actualPath = `file://${path}`;
    Share.open({
        url: actualPath
    })
    .then((res) => {
        console.log(res);
    })
    .catch((err) => {
        err && console.log(err);
    });
    ```
6. process the profile `npx react-native-release-profiler --local <path to profile>`
7. Open the profile in chrome://tracing

## API
 
 - `startProfiling()` - synchronously starts hermes profiler
 
 - `stopProfiling(saveInDownloadsDirectory: boolean): Promise<string>` - stops profiling and saves file in cache or downloads directory.
    - returns the path under which the profile has been saved

## Contributing

See the [contributing guide](CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
