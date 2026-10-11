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

function isMuted() {
  return Date.now() < mutedUntil;
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

// Already in the desktop app? Then "download the app" makes no sense: hide it.
// (Tauri puts __TAURI_INTERNALS__ on its pages; ordinary browsers don't have it.)
const inDesktopApp = "__TAURI_INTERNALS__" in window;
if (inDesktopApp) document.getElementById("desktop-app").hidden = true;

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

// How a channel is called: "#memes", or "@kari" for a DM (or "Friends" for that page).
function channelLabel(channel) {
  if (channel === FRIENDS) return "Friends";
  if (channel === LOUNGE) return "Lounge";
  const partner = dmPartner(channel);
  return partner === null ? "#" + channel : "@" + (people.get(partner)?.name ?? "someone");
}

// Notify: sound and/or a desktop notification. Clicking it opens that channel.
function notify(channel, senderId, senderName, text) {
  if (isMuted()) return;  // do not disturb: no sound, no popup (the red numbers still update)
  if (notificationSound) playPing();
  if (!desktopNotifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const isDm = dmPartner(channel) !== null;
  const avatar = people.get(senderId)?.avatar;
  try {
    const notification = new Notification(isDm ? senderName : `${senderName} in #${channel}`, {
      body: tokensToCodes(text),  // <@2> -> @kari, <:17> -> :pog:
      icon: avatar ? "/avatars/" + encodeURIComponent(avatar) : undefined,
      tag: channel,  // a newer one from the same channel replaces the older one
    });
    notification.addEventListener("click", () => {
      window.focus();
      switchChannel(channel, channelLabel(channel));
      notification.close();
    });
  } catch {
    // Some browsers (Android Chrome) refuse notifications without a service worker.
  }
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
