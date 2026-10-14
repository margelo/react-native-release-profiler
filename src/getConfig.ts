import { execFile } from 'child_process';
import path from 'path';
import { logger } from './logger';

interface Config {
  project: {
    android: {
      packageName: string;
    };
  };
  root: string;
}

/** `react-native config` of the project in the working directory. Rejects without printing:
 * callers decide whether the config is required. */
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
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        try {
          const config = JSON.parse(stdout);
          resolve(config);
        } catch (e) {
          reject(
            new Error(
              `Failed to parse the output of "npx react-native config" to JSON. Are you sure the output returns a JSON-only string?\nError: ${e}`
            )
          );
          return;
        }

        // If we get here it means that the config object could be parsed as JSON, so we can assume
        // that loading the config went fine. We still want to inform about any warnings or errors
        // that might have occured along the way:
        if (stderr) {
          logger.warn(
            `The following problem occured during retrieving the app's config:\n${stderr}`
          );
        }
      }
    );
  });
}

export default getConfig;
