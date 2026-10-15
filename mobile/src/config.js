// Which chat server the app talks to.
//
// Development: the server from start.ps1 on your PC. It only listens on the PC itself, so the
// phone reaches it through the USB cable: run `adb reverse tcp:8001 tcp:8001` once after
// plugging in, and the phone's own "localhost:8001" leads to the PC's.
//
// The real chat would be "https://chat.example.com" (https, so the WebSocket becomes wss).
export const SERVER = 'http://localhost:8001';

// The WebSocket's address: the same server with ws:// or wss:// instead of http:// or https://.
export const SOCKET_URL = SERVER.replace(/^http/, 'ws') + '/ws';
