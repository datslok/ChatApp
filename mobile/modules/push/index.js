// Our own native module (android/.../PushModule.kt and friends): push notifications through Firebase
// Cloud Messaging. The pushes themselves arrive in Kotlin (PushService.kt), which shows them even with
// the app closed; JavaScript only hands the server our token and handles taps.
import { requireNativeModule } from 'expo';

const Push = requireNativeModule('Push');

// This phone's token at FCM (its address there), for the server. `server`: our server's address, which
// the notifications need (pictures, Decline).
export function getToken(server) {
  return Push.getTokenAsync(server);
}

// The notification the app was started by, {channel, messageId, action}, or null. action: "open" (a
// message or friend request), "ring" (a call's notification) or "accept" (its Accept button).
export function getInitialOpen() {
  return Push.getInitialOpenAsync();
}

// Calls listener({channel, messageId, action}) for each notification tapped while the app is open.
// Returns a subscription (.remove()).
export function addOpenListener(listener) {
  return Push.addListener('onOpen', listener);
}

// Calls listener({token}) when Firebase gives this phone a new token.
export function addTokenListener(listener) {
  return Push.addListener('onToken', listener);
}

// Take a chat's notification away (it's been seen), or a call's (it rings in the app now).
export function clearChatNotification(channel) {
  Push.clearChat(channel);
}
export function clearCallNotification(channel) {
  Push.clearCall(channel);
}

// Is a call's notification ringing right now? (Android repeats its sound until it goes.)
export function isCallNotificationShowing(channel) {
  return Push.isCallShowing(channel);
}

// Are notifications allowed (Android's question, or its settings)? May a ringing call open the call
// screen over the lock screen?
export function notificationsAllowed() {
  return Push.notificationsAllowed();
}
export function canFillScreen() {
  return Push.canFillScreen();
}

// Android's settings pages: the app's notifications, and full-screen notifications.
export function openNotificationSettings() {
  Push.openNotificationSettings();
}
export function openFillScreenSettings() {
  Push.openFillScreenSettings();
}
