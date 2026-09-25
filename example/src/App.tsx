import * as React from 'react';
import { Button, Platform, StyleSheet, Text, View } from 'react-native';
import {
  startProfiling,
  startProfilingSession,
  stopProfiling,
} from 'react-native-release-profiler';

function sampleWorkload() {
  let result = 0;
  for (let index = 0; index < 500000; index++) {
    result += Math.sqrt(index);
  }
  return result;
}

export default function App() {
  const [status, setStatus] = React.useState('Ready to record');
  const [recording, setRecording] = React.useState(false);

  async function record() {
    setRecording(true);
    let workload: ReturnType<typeof setInterval> | undefined;
    try {
      const session =
        Platform.OS === 'android' && Number(Platform.Version) >= 35
          ? await startProfilingSession({ durationMs: 10000 })
          : undefined;
      if (!session) startProfiling();
      setStatus('Recording for 5 seconds…');
      workload = setInterval(sampleWorkload, 100);
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      clearInterval(workload);
      setStatus('Saving profile…');
      if (session) {
        const artifacts = await session.stop(true);
        setStatus(
          `Session: ${artifacts.sessionId}\nNative: ${artifacts.nativeStatus}\n` +
            (artifacts.nativeError ?? 'Saved to Downloads/release-profiler')
        );
      } else {
        setStatus(`Saved Hermes profile: ${await stopProfiling(true)}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (workload) clearInterval(workload);
      setRecording(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text selectable>{status}</Text>
      <Button title="Record profile" disabled={recording} onPress={record} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
