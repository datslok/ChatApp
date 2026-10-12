// The service worker: a script the browser installs for this site and keeps in the background,
// even while the chat isn't open. Registered by notifications.js; served at /sw.js (server.py),
// because a service worker only looks after the pages at or below its own address.
//
// For now it only has to exist: with it and static/manifest.json, phones offer "Install app" (a
// PWA: the chat with its own icon, in its own window). Push notifications will come here.
//
// On purpose, it keeps no copies of the page for offline use: a chat without a connection can't
// do anything, and copies could keep an old version of the page around after a deploy.

// A new version of this file takes over at once, instead of waiting until every chat tab is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
