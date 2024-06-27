import { exec } from 'child_process';

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
    exec('npx react-native config', (error, stdout, stderr) => {
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
      }

      if (stderr) {
        resolve(null);
        throw new Error(stderr);
      }
    });
  });
}

export default getConfig;
