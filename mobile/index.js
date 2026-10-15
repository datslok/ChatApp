// (First, before the app's own files: LiveKit's setup. Every import runs before the code under it, and
// in this order, so this way it's all there by the time App.js and the call code load.)
import './src/livekit-setup';
import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
