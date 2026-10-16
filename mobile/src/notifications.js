// Notifications on the phone (the web page's notifications.js, as far as a phone needs it):
//   - Push notifications through Firebase (modules/push): on from the first start (Android asks whether
//     we may), off and on in Settings → Notifications. At every connect we give the server this phone's
//     token (/push/fcm); it then sends DMs, mentions, friend requests and calls here while we aren't
//     looking at the chat anywhere (server.py, send_push), and Kotlin shows them, even with the app closed.
//   - The ping while the app is open: a DM or mention in another chat (the server's "unread" with
//     "notify") or a friend request. Its own switch and volume, like the web page's Sound.
//   - And a banner at the top for it (MessageBanner.js): who, where, the start of the message; a tap
//     goes there. Its own switch, like the web page's desktop notifications.
//   - Mute notifications for a while: both of the above (the server is told, /push/mute, for the pushes).
//   - A chat's notification goes away when the chat is opened here (the web page's clearSeenNotifications).
import { useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { createAudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { postJson } from './api';
import { SERVER } from './config';
import { addTokenListener, clearChatNotification, getToken, notificationsAllowed } from '../modules/push';

export const DEFAULT_NOTIFICATION_SETTINGS = {
  push: null,     // push notifications on this phone: true, false, or null = not decided yet (asked at the first start)
  sound: true,    // the ping while the app is open
  banner: true,   // the banner while the app is open
  volume: 100,    // its volume, 0-100 %
  mutedUntil: 0,  // muted until when (ms since 1970, like Date.now()), "forever", or 0: not muted
  muteChoice: 'off',  // the choice that muted it ("1h", ...), for Settings' highlighted button
};

const settingsFile = new File(Paths.document, 'notification-settings.json');

function loadSettings() {
  try {
    if (settingsFile.exists) return { ...DEFAULT_NOTIFICATION_SETTINGS, ...JSON.parse(settingsFile.textSync()) };
  } catch {}
  return DEFAULT_NOTIFICATION_SETTINGS;
}

function saveSettings(settings) {
  try {
    if (!settingsFile.exists) settingsFile.create();
    settingsFile.write(JSON.stringify(settings));
  } catch {}
}

// This phone's FCM token, once Firebase has given it to us. The server knows it as "fcm:<token>".
let token = null;
// Do pushes reach this phone now? (voice.js asks: a call ringing while the app is in the background
// then rings through its notification, not through the app's own sounds as well.)
let pushOnNow = false;
export function phonePushOn() {
  return pushOnNow;
}

// Logging out: this phone stops getting the account's pushes. (Before /logout, while still logged in.)
export async function forgetThisPhone() {
  pushOnNow = false;
  if (token) await postJson('/push/unsubscribe', { endpoint: 'fcm:' + token });
}

// Settings → Notifications' choices, as the moment the mute ends (the web page's muteSelect).
export const MUTE_CHOICES = [
  ['off', 'Off'], ['1h', 'For 1 hour'], ['8h', 'For 8 hours'], ['morning', 'Until 08:00'], ['forever', 'Until I turn it back on'],
];

function muteEnd(choice) {
  const now = Date.now();
  if (choice === '1h') return now + 60 * 60 * 1000;
  if (choice === '8h') return now + 8 * 60 * 60 * 1000;
  if (choice === 'forever') return 'forever';
  if (choice === 'morning') {
    const morning = new Date();
    morning.setHours(8, 0, 0, 0);  // today 08:00...
    if (morning.getTime() <= now) morning.setDate(morning.getDate() + 1);  // ...or tomorrow's, if that's passed
    return morning.getTime();
  }
  return 0;
}

// Muted on this phone right now? (A timed mute simply runs out: nothing needs to switch it off.)
export function isMuted(settings) {
  return settings.mutedUntil === 'forever' || Date.now() < settings.mutedUntil;
}

// The ping (tools/make_call_sounds.py, the web page's playPing): one player, started over each time.
let ping = null;
function playPing(volume) {
  if (volume <= 0) return;
  try {
    ping ??= createAudioPlayer(require('../assets/sounds/ping.wav'));
    ping.volume = volume / 100;
    ping.seekTo(0);
    ping.play();
  } catch {}
}

// connection: useConnection()'s. Kept in App.js's Screen, for as long as we're logged in.
export function useNotifications(connection) {
  const [settings, setSettingsState] = useState(loadSettings);
  const [problem, setProblem] = useState('');  // why push couldn't be turned on, for Settings
  const [busy, setBusy] = useState(false);     // turning push on or off right now
  // The banner showing (MessageBanner.js): the server's notify ({channel, id, user_id, name, text}) or
  // {request: true, user_id} for a friend request; with `at`, so a new one starts its own time. Or null.
  const [banner, setBanner] = useState(null);
  const latest = useRef({});
  latest.current = { settings, connection };
  const { me } = connection;

  function setSettings(changes) {
    const next = { ...latest.current.settings, ...changes };
    latest.current.settings = next;
    setSettingsState(next);
    saveSettings(next);
  }

  // Our mute, for the server: in seconds (Unix time), "until I turn it back on" being the year 2100.
  function sendMute() {
    if (!token) return;
    const { mutedUntil } = latest.current.settings;
    const until = mutedUntil === 'forever' ? 4102444800 : mutedUntil > Date.now() ? mutedUntil / 1000 : null;
    return postJson('/push/mute', { endpoint: 'fcm:' + token, until });
  }

  // Give the server our token (and our mute). ask: ask Android's permission first (Android 13+): at the
  // first start and from the switch in Settings. True if it worked.
  async function register(ask) {
    if (Platform.OS !== 'android') return false;
    if (ask && Platform.Version >= 33) {
      const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (answer !== PermissionsAndroid.RESULTS.GRANTED) {
        setProblem("ChatApp isn't allowed to show notifications: allow them in Android's settings for the app.");
        return false;
      }
    }
    try {
      token = await getToken(SERVER);
    } catch {
      setProblem("Couldn't reach Firebase, which brings the notifications. Try again in a moment.");
      return false;
    }
    const result = await postJson('/push/fcm', { token });
    if (!result.ok) {
      setProblem(result.error);
      return false;
    }
    await sendMute();
    setProblem('');
    // (Turned off in Android's settings since: then nothing shows, and Settings says why.)
    pushOnNow = notificationsAllowed();
    return true;
  }

  // At every connect ("welcome" brings a new `me`): register again (the server may have forgotten us,
  // or the token changed). The very first time, push turns on if Android lets us.
  useEffect(() => {
    if (!me?.phonePush) return;
    const { push } = latest.current.settings;
    if (push === false) return;
    register(push === null).then((worked) => {
      if (push === null) setSettings({ push: worked });
    });
  }, [me]);

  // A new token from Firebase while we're open.
  useEffect(() => {
    const subscription = addTokenListener(({ token: next }) => {
      token = next;
      if (latest.current.settings.push) postJson('/push/fcm', { token: next });
    });
    return () => subscription.remove();
  }, []);

  // Settings' switch.
  async function setPush(on) {
    setBusy(true);
    if (on) {
      setSettings({ push: await register(true) });
    } else {
      await forgetThisPhone();
      setSettings({ push: false });
    }
    setBusy(false);
  }

  function setMute(choice) {
    setSettings({ mutedUntil: muteEnd(choice), muteChoice: choice });
    sendMute();
  }

  // Muted here, or Do Not Disturb (our status, on every device).
  const quiet = () => isMuted(latest.current.settings) || latest.current.connection.myPresence === 'dnd';

  // A DM or mention in another chat while we're open: the ping and the banner. (connection.js calls
  // this with the server's notify.) Not in the background with push on: the connection may still be up
  // for a while, but the push's notification makes its own sound (the web page's "pushOn: not twice").
  // (No banner in the background at all: nobody would see it, and it'd still be there on coming back.)
  function notify(item) {
    const { sound, volume, banner: banners } = latest.current.settings;
    const active = AppState.currentState === 'active';
    if ((!active && pushOnNow) || quiet()) return;
    if (sound) playPing(volume);
    if (banners && active && item) setBanner({ ...item, at: Date.now() });
  }
  connection.notifyListener.current = notify;

  // A new friend request: the ping and a banner too (the web page's notifyFriendRequest). Not for the
  // ones already waiting when we connect.
  const knownRequests = useRef(null);
  useEffect(() => {
    const before = knownRequests.current;
    knownRequests.current = new Set(connection.incoming);
    const added = before ? connection.incoming.find((id) => !before.has(id)) : undefined;
    if (added !== undefined) notify({ request: true, user_id: added });
  }, [connection.incoming]);

  // The chat on screen has been seen: its notification goes (when it's opened, and when we come back to
  // the app with it open).
  useEffect(() => {
    if (connection.current && AppState.currentState === 'active') clearChatNotification(connection.current);
  }, [connection.current]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const chat = latest.current.connection.current;
      if (state === 'active' && chat) clearChatNotification(chat);
    });
    return () => subscription.remove();
  }, []);

  return {
    settings, problem, busy, banner,
    closeBanner: () => setBanner(null),
    setBanners: (on) => setSettings({ banner: on }),
    available: !!me?.phonePush,  // (the server has Firebase's key)
    setPush, setMute,
    setSound: (on) => {
      setSettings({ sound: on });
      if (on) playPing(latest.current.settings.volume);  // let them hear it
    },
    setVolume: (volume) => setSettings({ volume }),
    playPing: () => playPing(latest.current.settings.volume),
  };
}
