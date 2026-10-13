import * as React from 'react';
import { Button, Platform, StyleSheet, Text, View } from 'react-native';
import {
  startProfiling,
  startProfilingSession,
  stopProfiling,
} from 'react-native-release-profiler';
import { runSessionTestSuite } from './sessionTestSuite';
import { runAccuracyCapture } from './accuracyRun';

// Deliberately block JS while recording so each task is visible in sampled stacks.
function longMathTask() {
  const deadline = performance.now() + 200;
  let result = 0;
  do {
    for (let index = 1; index <= 10000; index++) {
      result += Math.sqrt(index) * Math.sin(index);
    }
  } while (performance.now() < deadline);
  return result;
}

function longSortTask() {
  const deadline = performance.now() + 300;
  let result = 0;
  do {
    const values = Array.from({ length: 4000 }, (_, index) =>
      Math.sin(index * 17)
    );
    values.sort((a, b) => a - b);
    result += values[0] ?? 0;
  } while (performance.now() < deadline);
  return result;
}

function longJsonTask() {
  const payload = JSON.stringify(
    Array.from({ length: 1000 }, (_, id) => ({
      id,
      title: `Profiling item ${id}`,
      values: [id, id * 2, id * 3],
    }))
  );
  const deadline = performance.now() + 400;
  let result = 0;
  do {
    result += JSON.stringify(JSON.parse(payload)).length;
  } while (performance.now() < deadline);
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
      setStatus('Recording math, sorting, and JSON long tasks for 5 seconds…');
      const tasks = [longMathTask, longSortTask, longJsonTask];
      let taskIndex = 0;
      workload = setInterval(() => {
        tasks[taskIndex % tasks.length]!();
        taskIndex++;
      }, 700);
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

  async function runExclusive(task: () => Promise<unknown>) {
    setRecording(true);
    try {
      await task();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRecording(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text selectable>{status}</Text>
      <Button title="Record profile" disabled={recording} onPress={record} />
      {Platform.OS === 'android' && Number(Platform.Version) >= 35 ? (
        <>
          <Button
            title="Run session test suite"
            disabled={recording}
            onPress={() => runExclusive(() => runSessionTestSuite(setStatus))}
          />
          <Button
            title="Accuracy capture 100 Hz"
            disabled={recording}
            onPress={() =>
              runExclusive(() => runAccuracyCapture(100, setStatus))
            }
          />
          <Button
            title="Accuracy capture 1000 Hz"
            disabled={recording}
            onPress={() =>
              runExclusive(() => runAccuracyCapture(1000, setStatus))
            }
          />
          <Button
            title="Legacy profile to Downloads"
            disabled={recording}
            onPress={() =>
              runExclusive(async () => {
                startProfiling();
                longMathTask();
                longSortTask();
                longJsonTask();
                const path = await stopProfiling(true);
                console.log(`[RPLEGACY] ${path}`);
                setStatus(`Legacy profile: ${path}`);
              })
            }
          />
        </>
      ) : null}
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
