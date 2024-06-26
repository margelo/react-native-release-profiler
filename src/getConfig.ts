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
        resolve(JSON.parse(stdout));
      } catch (e) {
        console.error(`JSON.parse error: ${e}`);
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
