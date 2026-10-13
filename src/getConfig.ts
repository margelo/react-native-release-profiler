import { execFile } from 'child_process';
import path from 'path';

interface Config {
  project: {
    android: {
      packageName: string;
    };
  };
  root: string;
}

function getConfig(): Promise<Config | null> {
  return new Promise((resolve, reject) => {
    // RN 0.80+ restricts package exports, so resolve cli.js next to package.json.
    const reactNativePath = path.join(
      path.dirname(require.resolve('react-native/package.json')),
      'cli.js'
    );

    execFile(
      process.execPath,
      [reactNativePath, 'config'],
      (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          reject(error);
          return;
        }

        try {
          const config = JSON.parse(stdout);
          resolve(config);
        } catch (e) {
          console.error(
            `Failed to parse the output of "npx react-native config" to JSON. Are you sure the output returns a JSON-only string?\nError: ${e}`
          );
          reject(e);
          return;
        }

        // If we get here it means that the config object could be parsed as JSON, so we can assume
        // that loading the config went fine. We still want to inform about any warnings or errors
        // that might have occured along the way:
        if (stderr) {
          console.warn(
            "The following problem occured during retrieving the app's config:"
          );
          console.warn(stderr);
        }
      }
    );
  });
}

export default getConfig;
