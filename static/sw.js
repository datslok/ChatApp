// The service worker: a script the browser installs for this site and keeps in the background,
// even while the chat isn't open. Registered by notifications.js; served at /sw.js (server.py),
// because a service worker only looks after the pages at or below its own address.
//
// With it and static/manifest.json, phones offer "Install app" (a PWA: the chat with its own icon,
// in its own window). And it shows push notifications: the server sends them (server.py,
// send_push) to devices that turned them on, while nobody's looking at the chat; the browser
// wakes this script up for each one, even with the chat closed.
//
// On purpose, it keeps no copies of the page for offline use: a chat without a connection can't
// do anything, and copies could keep an old version of the page around after a deploy.

// A new version of this file takes over at once, instead of waiting until every chat tab is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A push arrived: {title, body, icon, channel, message_id} for a message, {..., call: true} for a
// call. event.waitUntil: keep this script awake until the notification is shown.
self.addEventListener("push", (event) => {
  const push = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(push.title || "ChatApp", {
    body: push.body || "",
    icon: push.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",  // (Android: the small icon in the status bar)
    // One notification per channel: a newer message replaces the older one instead of piling up.
    // "renotify": still buzz for the newer one.
    tag: push.call ? "call:" + push.channel : push.channel,
    renotify: true,
    requireInteraction: Boolean(push.call),  // a call stays until it's tapped or swiped away
    data: { channel: push.channel, messageId: push.message_id ?? null },
  }));
});

// A notification was tapped: bring the chat forward and open that message (or the DM, for a call).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { channel, messageId } = event.notification.data || {};
  event.waitUntil((async () => {
    // A chat window that's already open on this device: use it ("postMessage": tell that page,
    // which listens for it in notifications.js).
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.length > 0) {
      await windows[0].focus();
      windows[0].postMessage({ type: "open", channel, messageId });
      return;
    }
    // None: open the chat, telling it where to go (core.js reads these from the address).
    const address = new URL("/", self.location.origin);
    if (channel) address.searchParams.set("channel", channel);
    if (messageId !== null) address.searchParams.set("message", messageId);
    await self.clients.openWindow(address.href);
  })());
});
