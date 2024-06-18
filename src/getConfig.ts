import { exec } from 'child_process';

function getConfig(): Promise<any> {
  return new Promise((resolve, reject) => {
    exec('npx react-native config', (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        reject(error);
        return;
      }

      resolve(JSON.parse(stdout));

      if (stderr) {
        throw new Error(stderr);
      }
    });
  });
}

export default getConfig;
