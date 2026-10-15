// Which chat server the app talks to.
//
// Development (__DEV__: a development build, its JavaScript coming live from Metro): the server from
// start.ps1 on your PC. It only listens on the PC itself, so the phone reaches it through the USB cable:
// run `adb reverse tcp:8001 tcp:8001` once after plugging in, and the phone's own "localhost:8001" leads
// to the PC's.
//
// A release build (the APK friends install): the real chat. Hosting your own? Put your address here
// (https, so the WebSocket becomes wss).
export const SERVER = __DEV__ ? 'http://localhost:8001' : 'https://chat.datslok.no';

// The WebSocket's address: the same server with ws:// or wss:// instead of http:// or https://.
export const SOCKET_URL = SERVER.replace(/^http/, 'ws') + '/ws';
