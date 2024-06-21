import React from 'react';
import { SafeAreaView, StatusBar, Text, View } from 'react-native';

const App = () => {
  return (
    <SafeAreaView>
      <StatusBar barStyle="dark-content" />
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontSize: 24 }}>React Native Web App Example</Text>
      </View>
    </SafeAreaView>
  );
};

export default App;
