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

// The noise gate (Settings → Voice & audio → Sensitivity): silent while quieter than this line, in dB
// (-100: off). And in a call: {level (dB, the newest 10 ms), open (the gate lets us through)}.
export function setGate(db) {
  CallService.setGate(db);
}
export function getMicLevel() {
  return CallService.getMicLevel();
}

// A call's short sound, "calling", "join" or "leave", played at once on the call's own sound channel
// (CuePlayer.kt), not as media (which waits while Android switches the audio into or out of call mode).
// "ring": someone calling us, as a ringtone (the ring volume); stopRing() cuts it off.
export function playCue(name) {
  CallService.playCue(name);
}
export function stopRing() {
  CallService.stopRing();
}

// Calls listener() when Hang up is tapped in the notification. Returns a subscription (.remove()).
export function addHangUpListener(listener) {
  return CallService.addListener('onHangUp', listener);
}
