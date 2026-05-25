const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Ensure EXPO_ROUTER_APP_ROOT is set for expo-router require.context
if (!process.env.EXPO_ROUTER_APP_ROOT) {
  const routerEntry = require.resolve('expo-router/entry');
  const appFolder = path.join(__dirname, 'app');
  process.env.EXPO_ROUTER_APP_ROOT = path.relative(path.dirname(routerEntry), appFolder);
}

const config = getDefaultConfig(__dirname);

module.exports = config;
