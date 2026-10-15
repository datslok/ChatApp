// Our own native module (android/.../CallService.kt and CallServiceModule.kt): keeps a call going with
// the phone locked. While a call is on, a foreground service shows "In a call · Lounge" (with Hang up)
// in the notifications, and the JavaScript timers keep running in the background.
import { AppRegistry } from 'react-native';
import { requireNativeModule } from 'expo';

const CallService = requireNativeModule('CallService');

// The "headless task" the module starts so React Native keeps the timers running (see
// CallServiceModule.kt). Its JavaScript has nothing to do: a promise that never resolves, so the task
// lasts until the module finishes it when the call ends. (Registered once, when this file loads.)
AppRegistry.registerHeadlessTask('ChatAppCall', () => () => new Promise(() => {}));

// Start the service, or change its notification (and whether the camera is on). Only while the app is
// on screen: Android refuses to start it from the background.
export function startCallService(title, text, camera) {
  return CallService.start(title, text, camera);
}

export function stopCallService() {
  return CallService.stop();
}

// The microphone's processing in calls (MicProcessor.kt): its volume (0-200 %), and whether RNNoise (the AI
// noise suppression, compiled in from Xiph's C code) cleans it. Take effect at once, also mid-call.
export function setMicVolume(percent) {
  CallService.setMicVolume(percent);
}
export function setAiNoiseSuppression(on) {
  CallService.setAiNoiseSuppression(on);
}

// Calls listener() when Hang up is tapped in the notification. Returns a subscription (.remove()).
export function addHangUpListener(listener) {
  return CallService.addListener('onHangUp', listener);
}
