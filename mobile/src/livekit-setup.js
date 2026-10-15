// LiveKit (calls, src/voice.js) was written for browsers: registerGlobals gives it what a browser has and
// React Native doesn't (WebRTC itself, from @livekit/react-native-webrtc, and a few smaller things).
// index.js imports this file first of all.
import { registerGlobals } from '@livekit/react-native';

registerGlobals();
