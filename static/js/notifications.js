// Notifications (sound, desktop notifications, the count in the title), and every
// sound the chat makes (generated with Web Audio).
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ---------- Notifications ----------
// For DMs and mentions, when we're not looking: a desktop notification, a "ping", and a count
// in the tab title. (Only while this page is open; a closed page can't notify.)

// The two switches, remembered in this browser. On unless switched off.
function loadSetting(key) {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function saveSetting(key, on) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {}
}

let desktopNotifications = loadSetting("notifyDesktop");
let notificationSound = loadSetting("notifySound");

// The ping's volume, 0-100 (%). 100 unless changed.
let notificationVolume = 100;
try {
  const saved = localStorage.getItem("notifyVolume");
  if (saved !== null) notificationVolume = Number(saved);
} catch {}

notifyVolumeSlider.addEventListener("input", () => {  // while dragging: show the number
  notificationVolume = Number(notifyVolumeSlider.value);
  notifyVolumeValue.textContent = notificationVolume + "%";
  try {
    localStorage.setItem("notifyVolume", String(notificationVolume));
  } catch {}
});
notifyVolumeSlider.addEventListener("change", () => playPing());  // let go: hear it

// Muted until when, as a point in time (milliseconds since 1970, like Date.now()).
// 0 = not muted; Infinity = until turned back on. Once the time has passed, it's simply
// not muted anymore: nothing needs to switch it off.
let mutedUntil = 0;
try {
  const saved = localStorage.getItem("mutedUntil");
  if (saved === "forever") mutedUntil = Infinity;
  else if (saved) mutedUntil = Number(saved);
} catch {}

// Muted on this device (Settings → Notifications), or Do Not Disturb (our status, on every device).
function isMuted() {
  return Date.now() < mutedUntil || myPresence === "dnd";
}

muteSelect.addEventListener("change", () => {
  const now = Date.now();
  const choice = muteSelect.value;
  if (choice === "off") mutedUntil = 0;
  else if (choice === "1h") mutedUntil = now + 60 * 60 * 1000;
  else if (choice === "8h") mutedUntil = now + 8 * 60 * 60 * 1000;
  else if (choice === "forever") mutedUntil = Infinity;
  else if (choice === "morning") {
    const morning = new Date();
    morning.setHours(8, 0, 0, 0);  // today 08:00:00.000...
    if (morning.getTime() <= now) morning.setDate(morning.getDate() + 1);  // ...or tomorrow's, if that's passed
    mutedUntil = morning.getTime();
  }
  try {
    localStorage.setItem("mutedUntil", mutedUntil === Infinity ? "forever" : String(mutedUntil));
  } catch {}
  showMuteState();
  sendPushMute();  // this device's pushes too (below, "Push notifications")
});

// Show whether (and until when) we're muted: in Settings, and as 🔕 next to "Settings".
function showMuteState() {
  const muted = isMuted();
  mutedIcon.hidden = !muted;
  if (!muted) {
    muteSelect.value = "off";
    muteStatus.textContent = "";
  } else if (mutedUntil === Infinity) {
    muteSelect.value = "forever";
    muteStatus.textContent = "Muted until you turn it back on.";
  } else {
    const until = new Date(mutedUntil);
    const sameDay = until.toDateString() === new Date().toDateString();
    muteStatus.textContent = "Muted until " + (sameDay ? formatClock(until) : until.toLocaleString()) + ".";
  }
}

// When a timed mute runs out, the 🔕 should go away by itself: check once a minute.
setInterval(showMuteState, 60 * 1000);
showMuteState();

// Show the switches as they are, with a word about the browser's permission if needed.
function showNotificationSettings() {
  notifySoundBox.checked = notificationSound;
  notifyVolumeSlider.value = notificationVolume;
  notifyVolumeValue.textContent = notificationVolume + "%";
  showMuteState();
  if (!("Notification" in window)) {  // (e.g. most phone browsers)
    notifyDesktopBox.checked = false;
    notifyDesktopBox.disabled = true;
    notifyHelp.textContent = "This browser can't show notifications from a web page.";
    return;
  }
  notifyDesktopBox.checked = desktopNotifications && Notification.permission !== "denied";
  if (Notification.permission === "denied") {
    notifyHelp.textContent = "Blocked by the browser. Allow notifications for this site in the browser's site settings (the padlock left of the address).";
  } else if (desktopNotifications && Notification.permission === "default") {
    notifyHelp.textContent = "Tick the box once more so the browser can ask for permission.";
    notifyDesktopBox.checked = false;
  } else {
    notifyHelp.textContent = "";
  }
}

notifyDesktopBox.addEventListener("change", async () => {
  if (notifyDesktopBox.checked && Notification.permission !== "granted") {
    // Browsers only allow this question right after a click, which is why it's here.
    await Notification.requestPermission();  // "Allow" or "Block"
  }
  desktopNotifications = notifyDesktopBox.checked && Notification.permission === "granted";
  saveSetting("notifyDesktop", notifyDesktopBox.checked);
  showNotificationSettings();
});

notifySoundBox.addEventListener("change", () => {
  notificationSound = notifySoundBox.checked;
  saveSetting("notifySound", notificationSound);
  if (notificationSound) playPing();  // let them hear it
});

showNotificationSettings();

// The service worker (static/sw.js): with it and the manifest, phones offer "Install app".
// ("in navigator": only browsers that have service workers; .catch: nothing to do without one.)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// Already in the desktop app? Then "download the app" makes no sense: hide it.
// (Tauri puts __TAURI_INTERNALS__ on its pages; ordinary browsers don't have it.)
const inDesktopApp = "__TAURI_INTERNALS__" in window;

// ----- Push notifications (the phone app): notifications on this device while the chat is closed.
// Turning them on asks the browser for a "subscription": this device's address at its push
// service, and keys to encrypt pushes for it. The server keeps it (server.py, "Push notifications")
// and sends pushes there; the service worker (sw.js) shows them. Not in the Windows app, which
// has its own notifications.

const pushRow = document.getElementById("push-row");
const pushBox = document.getElementById("notify-push");
const pushHelp = document.getElementById("push-help");
const canPush = "serviceWorker" in navigator && "PushManager" in window && !inDesktopApp;
let vapidPublicKey = null;  // the server's public key, from "welcome" (core.js); null: not set up
let pushOn = false;  // does this device get pushes? Then the page doesn't notify by itself (notify)

if (canPush) currentSubscription().then((subscription) => { pushOn = Boolean(subscription); });

// Tell the server whether we're looking at the chat (tab in sight and window focused): while we
// are, on any device, nobody pushes us anything (server.py, send_push). On every change, and on
// each new connection (core.js). "blur": the window lost the focus. "app": this is the Windows
// app, which notifies by itself: while it's open at all, our phones get no pushes either.
function sendLooking() {
  if (socket) sendToServer({ type: "looking", looking: isLooking(), app: inDesktopApp, mobile: onPhone });  // (no connection yet: on "open")
  clearSeenNotifications();
}

// Push notifications for the channel we're looking at have been seen: take them off the phone.
// (They belong to the phone, not the page: only tapping one, or this, removes them. Each one
// carries its channel in "data", sw.js; a call's is its DM.) Also after switching (core.js).
async function clearSeenNotifications() {
  if (!canPush || !isLooking() || currentChannel === null) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  for (const notification of await registration.getNotifications()) {
    if (notification.data?.channel === currentChannel) notification.close();
  }
}
document.addEventListener("visibilitychange", sendLooking);
window.addEventListener("focus", sendLooking);
window.addEventListener("blur", sendLooking);

// A push notification was tapped while the chat was open on this device: sw.js asks us to go there.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "open") openMessage(event.data.channel, event.data.messageId);
  });
}

// "Mute notifications" for this device's pushes too: the server can't see our localStorage, so
// it's told. In seconds (Unix time); "until I turn it back on" is the year 2100.
async function sendPushMute() {
  const subscription = canPush ? await currentSubscription() : null;
  if (!subscription) return;
  const until = !isMuted() ? null : mutedUntil === Infinity ? 4102444800 : mutedUntil / 1000;
  fetch("/push/mute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint, until }),
  }).catch(() => {});
}

// The browser wants the key as bytes; the server sends it as base64url text (- and _ instead of
// + and /). atob turns ordinary base64 into a "binary string", one character per byte.
function keyBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

// This device's subscription, or null. (serviceWorker.ready: once sw.js is running.)
async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

// The switch, as it is now (Settings calls this when it opens).
async function showPushSetting() {
  pushRow.hidden = !(canPush && vapidPublicKey);
  if (pushRow.hidden) return;
  pushBox.checked = Boolean(await currentSubscription());
  if (Notification.permission === "denied") {
    pushHelp.textContent = "Notifications are blocked for this site. " +
      "Allow them in the site's settings, and on a phone also in its own settings for the browser or the app.";
  }
}

async function turnOnPush() {
  // Browsers only ask right after a click, which is why it happens here.
  if (await Notification.requestPermission() !== "granted") throw new Error("Notifications aren't allowed.");
  const registration = await navigator.serviceWorker.ready;
  // userVisibleOnly: we promise every push shows a notification (browsers insist on it).
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(vapidPublicKey),
  });
  const { endpoint, keys } = subscription.toJSON();  // keys: {p256dh, auth}, already as base64url text
  const response = await fetch("/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth }),
  });
  if (!response.ok) {
    await subscription.unsubscribe();  // the server didn't take it: don't keep half of it
    throw new Error((await response.json()).detail || "The server didn't accept it.");
  }
  sendPushMute();  // muted right now? Then the new subscription is too
}

async function turnOffPush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await fetch("/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

pushBox.addEventListener("change", async () => {
  pushBox.disabled = true;  // (until it's done: subscribing takes a moment)
  pushHelp.textContent = "";
  try {
    if (pushBox.checked) await turnOnPush();
    else await turnOffPush();
  } catch (error) {
    pushHelp.textContent = "Couldn't change it: " + error.message;
  }
  pushBox.disabled = false;
  pushOn = Boolean(await currentSubscription());
  showPushSetting();
});

// ----- The phone banner: on a phone, offer the two steps that make the chat a real phone app,
// one at a time, until they're done or the banner is closed:
//   "install": install it (a PWA). Chrome on Android fires "beforeinstallprompt" when a site can
//              be installed; we keep that event, and our button opens Chrome's install dialog
//              with it. Safari on iPhones has no such thing: there, the steps in words.
//   "notify":  turn on push notifications (the same as the switch in Settings).

const phoneBanner = document.getElementById("phone-banner");
const phoneBannerTitle = document.getElementById("phone-banner-title");
const phoneBannerText = document.getElementById("phone-banner-text");
const phoneBannerAction = document.getElementById("phone-banner-action");
// A phone (the browser's description of itself names one; never the Windows app). For the banner, and
// sent in "looking" (sendLooking): others see a little phone for our dot while we're only here on
// phones (server.py, on_phone_only).
const onPhone = /Android|iPhone|iPad/.test(navigator.userAgent);
const onIPhone = /iPhone|iPad/.test(navigator.userAgent);
// Running as the installed app? It has no address bar ("standalone"); iPhones say it their own way.
const runningAsApp = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let installPrompt = null;  // Chrome's install dialog, kept for our button

// "Desktop notifications" means nothing on a phone: phone browsers only show notifications
// through the service worker (pushes), never the page's own. The push switch is the one there.
if (onPhone) {
  notifyDesktopBox.closest("label").hidden = true;
  notifyHelp.hidden = true;  // (its hints are about that checkbox)
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();  // not Chrome's own little bar: our banner asks instead
  installPrompt = event;
  showPhoneBanner();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  showPhoneBanner();
});

// Which step to offer now, if any: shown again whenever something changes (the install prompt
// arrives, "welcome" brings the server's push key, a step is done).
async function showPhoneBanner() {
  let step = null;
  if (onPhone && loadSetting("phoneBanner")) {
    if (!runningAsApp && (installPrompt || onIPhone)) {
      step = "install";
    } else if (canPush && vapidPublicKey && !(await currentSubscription())) {
      step = "notify";
    }
  }
  phoneBanner.hidden = step === null;
  phoneBanner.dataset.step = step ?? "";
  if (step === "install") {
    phoneBannerTitle.textContent = "Get ChatApp on your phone";
    phoneBannerText.textContent = onIPhone
      ? "In Safari: tap Share, then Add to Home Screen. Notifications work in the app."
      : "Its own icon and window, and notifications when it's closed.";
    phoneBannerAction.textContent = "Install";
    phoneBannerAction.hidden = !installPrompt;  // (on an iPhone, the words above are the way)
  } else if (step === "notify") {
    phoneBannerTitle.textContent = "Get notifications";
    phoneBannerText.textContent = "For DMs, mentions and calls, also when the chat is closed.";
    phoneBannerAction.textContent = "Turn on";
    phoneBannerAction.hidden = false;
  }
}

phoneBannerAction.addEventListener("click", async () => {
  if (phoneBanner.dataset.step === "install" && installPrompt) {
    installPrompt.prompt();  // Chrome's own "Install app?" dialog
    await installPrompt.userChoice;  // (Install or Cancel: either way, it can only be used once)
    installPrompt = null;
  } else if (phoneBanner.dataset.step === "notify") {
    try {
      await turnOnPush();  // (the same as the switch in Settings → Notifications)
      pushOn = true;
    } catch (error) {
      phoneBannerText.textContent = "Couldn't turn them on: " + error.message;
      return;
    }
  }
  showPhoneBanner();
});

document.getElementById("phone-banner-close").addEventListener("click", () => {
  phoneBanner.hidden = true;
  saveSetting("phoneBanner", false);  // (Settings → Notifications still has the switch)
});

// The "get the app" banner above the chat: only in a browser on Windows (the app is Windows-only;
// every browser's userAgent, the description it gives of itself, names the system it runs on),
// and only until they close it. Closing it is remembered in this browser, like the settings above.
const appBanner = document.getElementById("app-banner");
if (!inDesktopApp && navigator.userAgent.includes("Windows") && loadSetting("appBanner")) {
  appBanner.hidden = false;
}
document.getElementById("app-banner-close").addEventListener("click", () => {
  appBanner.hidden = true;
  saveSetting("appBanner", false);
});

// Our sounds (the ping, the ringtone, the calling sound, the join and leave cues) are generated
// by the browser (Web Audio): no sound files needed. They all share this one AudioContext.
let audio = null;
let audioSleepTimer = null;  // pauses it a moment after the last sound (playTone)

// One soft note. It fades in along a straight line from silence: an exponential fade-in stays
// near silent and then jumps up at the very end, which the ear hears as a click. It fades out
// exponentially (that sounds natural), and only stops once it's silent.
// start: seconds from now; length: until it has faded out; peak: its loudest volume (0-1).
//
// Everything is scheduled 50 ms ahead: the audio engine works in small batches, so by the time
// it reads a note set for "now", now has passed, and it would join the fade-in halfway, with a
// jump in volume (a tick). 50 ms ahead, it sees the whole fade-in from its start.
const SOUND_LEAD = 0.05;

function playTone(pitch, start, length, peak) {
  audio ??= new AudioContext();  // created once, the first time
  // A paused AudioContext's clock stands still, and notes scheduled on it would start all at
  // once when it wakes. (Browsers pause it until the page has been clicked.)
  if (audio.state === "suspended") audio.resume();
  const at = audio.currentTime + SOUND_LEAD + start;
  const tone = audio.createOscillator();  // makes the tone: a sine wave at this pitch
  const volume = audio.createGain();      // a volume knob, turned by the schedule below
  tone.frequency.value = pitch;
  volume.gain.value = 0;
  volume.gain.setValueAtTime(0, at);
  volume.gain.linearRampToValueAtTime(peak, at + 0.025);      // up in 25 ms, evenly
  volume.gain.exponentialRampToValueAtTime(0.0001, at + length);  // and fade out
  tone.connect(volume).connect(audio.destination);  // tone -> volume -> speakers
  tone.start(at);
  tone.stop(at + length + 0.05);  // a moment after it's silent
  // Pause the engine a second after the last note: running, it keeps playing silence, which keeps
  // a phone's sound hardware awake (battery). Each new note moves this further away; the next
  // sound wakes it again (above).
  clearTimeout(audioSleepTimer);
  audioSleepTimer = setTimeout(() => audio.suspend(), (SOUND_LEAD + start + length + 1) * 1000);
}

function playPing() {
  if (notificationVolume <= 0) return;
  try {
    const peak = 0.15 * (notificationVolume / 100);  // the loudest point, scaled by the slider
    playTone(880, 0, 0.15, peak);      // A5
    playTone(1175, 0.08, 0.4, peak);   // then D6: two quick notes, like a soft chime
  } catch {
    // No sound possible (old browser, or no click on the page yet): just skip it.
  }
}

// Are we looking at the chat right now? (Tab visible and window focused.)
function isLooking() {
  return !document.hidden && document.hasFocus();
}

// How a channel is called: "#memes", "@kari" for a DM, a group's name (or "People" for that page).
function channelLabel(channel) {
  if (channel === FRIENDS) return "People";
  if (channel === LOUNGE) return "Lounge";
  if (isGroup(channel)) return groupLabel(channel);
  const partner = dmPartner(channel);
  return partner === null ? "#" + channelName(channel) : "@" + (people.get(partner)?.name ?? "someone");
}

// Notify: sound and/or a desktop notification. Clicking it opens that message.
function notify(channel, messageId, senderId, senderName, text) {
  if (isMuted()) return;  // do not disturb: no sound, no popup (the red numbers still update)
  if (pushOn) return;  // this device gets a push for it instead (sw.js): not twice
  if (notificationSound) playPing();
  if (!desktopNotifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const isDm = dmPartner(channel) !== null;
  const avatar = people.get(senderId)?.avatar;
  try {
    const notification = new Notification(isDm ? senderName : `${senderName} in ${channelLabel(channel)}`, {
      body: tokensToCodes(text),  // <@2> -> @kari, <:17> -> :pog:
      icon: avatar ? "/avatars/" + encodeURIComponent(avatar) : undefined,
      tag: channel,  // a newer one from the same channel replaces the older one
      // For the desktop app: its notification plugin hands this back when the notification is
      // clicked, and the app then calls openMessage with it (main.rs). Browsers ignore it.
      extra: { channel, messageId },
    });
    // In the desktop app, Notification is the plugin's stand-in, which has no click event.
    if (!inDesktopApp) {
      notification.addEventListener("click", () => {
        openMessage(channel, messageId);
        notification.close();
      });
    }
  } catch {
    // Some browsers (Android Chrome) refuse notifications without a service worker.
  }
}

// A new friend request (core.js, "friends"): the ping and a desktop notification, like a DM.
// Clicking it opens the Friends page's Requests tab (openMessage with FRIENDS).
function notifyFriendRequest(userId) {
  if (isMuted()) return;
  if (pushOn) return;  // this device gets a push for it instead (server.py, friend_request): not twice
  if (notificationSound) playPing();
  if (!desktopNotifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const person = people.get(userId);
  try {
    const notification = new Notification(person?.name ?? "Someone", {
      body: "👋 sent you a friend request",
      icon: person?.avatar ? "/avatars/" + encodeURIComponent(person.avatar) : undefined,
      tag: "friend-request-" + userId,
      extra: { channel: FRIENDS, messageId: null },  // (for the desktop app, as in notify)
    });
    if (!inDesktopApp) {
      notification.addEventListener("click", () => {
        openMessage(FRIENDS, null);
        notification.close();
      });
    }
  } catch {}
}

// A notification was clicked: show that channel and go to the message. Called from the
// click handler above, and by the desktop app (main.rs). In another channel, the message only
// arrives with that channel's history, so the jump waits for it (core.js, "history").
// messageId null: just the channel (a call's notification opens the DM). FRIENDS: the Friends
// page, on its Requests tab (a friend request's notification).
function openMessage(channel, messageId) {
  window.focus();
  if (channel === FRIENDS) document.querySelector('.tab[data-tab="requests"]')?.click();  // (people.js)
  if (channel === currentChannel) {
    if (messageId !== null) jumpToMessage(messageId);
    return;
  }
  switchChannel(channel, channelLabel(channel));
  pendingJump = messageId;  // after switchChannel, which forgets any older one
}

// The tab title: "(3) ChatApp". Counts the red numbers, plus mentions that arrived in the
// channel we're in while we weren't looking.
let missedWhileAway = 0;

function updateTitle() {
  let total = missedWhileAway;
  for (const count of mentionCounts.values()) total += count;
  document.title = total > 0 ? `(${total}) ChatApp` : "ChatApp";
}

// Back to the chat: those missed ones are seen now.
function cameBack() {
  if (isLooking() && missedWhileAway > 0) {
    missedWhileAway = 0;
    updateTitle();
  }
}
document.addEventListener("visibilitychange", cameBack);  // the tab became visible (or hidden)
window.addEventListener("focus", cameBack);               // the window got focus
