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

      resolve(JSON.parse(stdout));

      if (stderr) {
        resolve(null);
        throw new Error(stderr);
      }
    });
  });
}

export default getConfig;
