# react-native-release-profiler

Finally a reliable way to profile our apps. No more false-positives or findings issues that are only present in debug build.
In Debug builds (even when you use release bundle) a lot of things can take much more time than it actually takes on production. 
For instance garbage collection or JSI calls. Because of that every thing we find slow using hermes profiler has to be verified using release build. With this library you can run hermes profiler using release builds which simplifies the whole process. Additionally you can use the library on production to let the most challening users send you performance profiles.

## Need some help with performance issues?

If have any problems with performance feel free to reach out to us at `hello@margelo.io`. 

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
   ```ts
   import { startProfiling } from 'react-native-release-profiler';

   startProfiling()
   ```
4. stop profiling
   ```ts
   import { stopProfiling } from 'react-native-release-profiler';

   stopProfiling(true)
   ```
5. Fetch and process the profile `npx react-native-release-profiler --fromDownload --appId [your appId]`
6. Open the profile in chrome://tracing

## Usage (iOS)

1. Install the library `yarn add react-native-release-profiler`
2. Build the app in release mode
3. start profling 
   ```ts
   import { startProfiling } from 'react-native-release-profiler';

   startProfiling()
   ```
4. stop profiling and keep the path
   ```ts
   import { stopProfiling } from 'react-native-release-profiler';

   const path = stopProfiling(true)
   ```
5. Send file from phone to your mac through AirDrop
    ```ts
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
