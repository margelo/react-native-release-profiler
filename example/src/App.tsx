import * as React from 'react';

import { StyleSheet, View, Text } from 'react-native';
import { startProfiling, stopProfiling } from 'react-native-release-profiler';
import Share from 'react-native-share';

startProfiling()

setTimeout(async () => {
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
}, 10000)

function FFFF() {
  let x = 2;
  for (let i = 9; i < 1e7; ++i) {
    x += x * i ^ 2
  }
  return x;
}

export default function App() {
  const [result, _] = React.useState<number | undefined>();

  React.useEffect(() => {
   FFFF()
  }, []);

  return (
    <View style={styles.container}>
      <Text>Result: {result}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: {
    width: 60,
    height: 60,
    marginVertical: 20,
  },
});
