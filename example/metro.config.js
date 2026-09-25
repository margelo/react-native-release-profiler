const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');
const pak = require('../package.json');

const root = path.resolve(__dirname, '..');
const singletonModules = ['react', 'react-native'];

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [root],
  resolver: {
    useWatchman: process.env.RELEASE_PROFILER_NO_WATCHMAN !== '1',
    // Force library sources outside this workspace to share the app's React runtime.
    resolveRequest(context, moduleName, platform) {
      const singleton = singletonModules.find(
        (name) => moduleName === name || moduleName.startsWith(`${name}/`)
      );
      if (singleton) {
        return context.resolveRequest(
          { ...context, originModulePath: path.join(__dirname, 'index.js') },
          moduleName,
          platform
        );
      }
      if (moduleName === pak.name) {
        return context.resolveRequest(
          context,
          path.join(root, pak.source),
          platform
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
});
