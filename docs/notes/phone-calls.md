# The phone app: calls and push

Covers: `mobile/src/voice.js`, `mobile/src/Call`, `mobile/src/IncomingCall.js`, `mobile/src/LoungeScreen.js`, `mobile/src/VoiceSettings.js`, `mobile/src/livekit-setup.js`, `mobile/src/callStats.js`, `mobile/src/notifications.js`, `mobile/src/NotificationSettings.js`, `mobile/modules/call-service/`, `mobile/modules/push/`

The native app's calls (LiveKit, mic processing, the call service for a locked phone, call screens) and its push notifications through Firebase. Setup, layout and the connection: [phone-app.md](phone-app.md); messages and people: [phone-messages.md](phone-messages.md).

## Calls

Since 2026-10-15. See [voice.md](voice.md) for LiveKit, the web's calls and the server's ringing.

### Packages

- `livekit-client` + `@livekit/react-native` 3.0 + `@livekit/react-native-webrtc` 144 +
  `@livekit/react-native-expo-plugin` 1.0.3 (1.0.2 breaks on SDK 57; audioType communication).
- `registerGlobals()` is in `src/livekit-setup.js`, imported first by index.js (imports run before code).
- `@config-plugins/react-native-webrtc` was dropped: LiveKit's own manifest has the permissions, and it would add
  SYSTEM_ALERT_WINDOW.

### `src/voice.js`

`useVoice` lives in App.js's `Screen`, so a call outlives Main.

- **Join**: RECORD_AUDIO asked, `startCallService`, AudioSession communication with preferredOutputList
  bluetooth/headset/speaker, /voice-token, `Room` with micOptions and the Settings camera. Then leave.
- **Mute/deafen** like the web. **Volumes**: `participant.setVolume`, 0-2.
- **Speaking rings**: from LiveKit's native `createVolumeProcessor`, straight on
  `NativeModules.LivekitReactNativeModule` (LK_VOLUME_PROCESSED ~100/s per track, checked every 50 ms, -50 dB,
  0.3 s; -1 = our own mic). Our own ring = the gate open (see below).
- **Camera**: `CAMERA_CAPTURE` 4:3 960x720, the sensor's shape (16:9 cut the sides off). `CAMERA_PUBLISH` H.264
  1.7 Mbit/s, which the phone encodes in hardware (c2.qti.avc.encoder); VP8 was libvpx in software and went blurry
  now and then. `facingMode`; flipping uses `restartTrack`, passing the size too.
- **Screen share**: react-native-webrtc's MediaProjectionService; no sound. `ShareMenu` (CallParts, rendered in
  App.js) offers sizes from SHARE_HEIGHTS up to the screen's short side, made by the sender's
  `scaleResolutionDownBy` (react-native-webrtc always captures the whole screen at 30 fps); H.264 without
  simulcast.
- **Outputs**: `AudioSession.getAudioOutputs`/`selectAudioOutput`.
- **Ringing**: `callListener` in connection.js; `outgoing`, `incoming`, `notice`; sounds + `Vibration`, none on
  dnd. No own ringing in the background with push on, nor while the call's notification is showing (Android's loop
  keeps going when the app is paused); `acceptFromNotification`.
- **The screen stays on** for the whole call: **expo-keep-awake** in useVoice while `roomName` is set (the
  window's FLAG_KEEP_SCREEN_ON, only while the app is in front). The user's choice over only in FocusView,
  2026-10-21.
- `voice-settings.json` in Paths.document: noiseSuppression on/light/off like the web, micVolume, outputVolume,
  personVolumes, screenVolumes, camera user/environment, floatCorner.
- connection.js: `voiceMembers`, `dmCalls`, `sendVoice` (re-sent at every reconnect), `ring`/`answerCall`/
  `cancelCall`.

### Mic processing

The user's wish, like the web.

- `MicProcessor.kt` in the call-service module is LiveKit's `audioProcessingController.capturePostProcessor`
  (set in the module's OnCreate). WebRTC hands it 480 floats per 10 ms at 48 kHz, in the 16-bit range.
- It runs RNNoise ("on"; "light" is the `noiseSuppression` constraint, in micOptions), then the gain.
  `setAiNoiseSuppression`/`setMicVolume` are called from voice.js.
- Calls parity (2026-10-16, needs the APK after 1.0.1): after RNNoise and the mic volume comes the noise gate
  (`gateDb`; voice-gate.js's 0.3 s hold and 5 ms fade; setting `gate`, default -60). It publishes `level`/`open`,
  read by `getMicLevel()`: our own speaking ring = the gate open, and Settings' meter in a call.
- RNNoise 0.2 is C in `src/main/cpp/rnnoise-0.2/` (committed). `tools/get_rnnoise.py` fetches it: Xiph's release
  tarball pinned by SHA-256 after checking it against the signed v0.2 tag, plus five headers from commit 372f7b4,
  since 0.2's ARM code includes a missing os_support.h.
- `src/main/cpp/CMakeLists.txt` builds it into libchatappaudio.so (~1.4 MB per ABI, 16 KB pages) with the JNI
  bridge `denoiser.c` / `Denoiser.kt`.

### Sounds

From `tools/make_call_sounds.py` (rooms.js's tones).

- The ringtone at first went through **expo-audio** (plugin with enableBackgroundPlayback false: no media service
  of its own; `mobile/assets/sounds/ring.wav`). Since calls parity (2026-10-16) `CuePlayer.kt` plays "ring" in a
  SoundPool of its own with USAGE_NOTIFICATION_RINGTONE (res/raw/chatapp_ring.wav from make_call_sounds.py;
  `stopRing`).
- Calling/join/leave go through the call-service module's `CuePlayer.kt` (SoundPool,
  USAGE_VOICE_COMMUNICATION_SIGNALLING, res/raw), because media sounds waited 5-6 s while Android switched into or
  out of call mode. The in-call cues stay signalling.

### The call service (locked phone)

Our module `mobile/modules/call-service` (Kotlin). Its own AndroidManifest.xml is merged in:
FOREGROUND_SERVICE_MICROPHONE/CAMERA/MEDIA_PLAYBACK/MEDIA_PROJECTION, and the service with those types.

- `CallService`: startForeground with the types we have permission for, the "Ongoing calls" channel, Hang up ->
  "onHangUp", a partial wake lock; stops on onTaskRemoved.
- A **headless JS task** (`ChatAppCall`, registered in index.js of the module) runs for the call's length, because
  React Native pauses every JS timer in the background unless one runs (JavaTimerManager). That would stop
  LiveKit's pings and negotiation (livekit/client-sdk-react-native#437) and the chat socket's reconnecting.
- Notifications: the module's manifest has POST_NOTIFICATIONS, asked for at each join (Android 13+). Without it
  even the foreground service's notification is hidden.
- Its channel "ongoing_calls" is default importance with no sound and VISIBILITY_PUBLIC. The first, low-importance
  "calls" one, which Samsung hid from the lock screen, is deleted.

### Call screens

- `src/CallParts.js`: RoundButton, `makeTiles`, CallTile with `<VideoTrack>`, TileGrid = fitTiles, OutputButton's
  Sheet, CallControls, `ShareMenu`.
  - FocusView: a tap on a tile opens it over the screen. Only while it's open may the app rotate
    (**expo-screen-orientation**: `unlockAsync` = Android's UNSPECIFIED, which follows the phone's auto-rotate;
    closing locks PORTRAIT_UP again; sideways it fills the screen; the user's wish, 2026-10-21). Its ×, name band
    and volume slider fade out after `CONTROLS_FOR` 3 s; a tap toggles them, so × or back closes it.
- `src/LoungeScreen.js`: the `voice:lounge` view; App.js `pick` joins it like the web.
- `src/CallBanner.js`: 40% of the height above a DM's/group's chat; its grip (PanResponder, `bannerHeight`).
- `src/IncomingCall.js`.
- `mobile/src/CallFloat.js`: the floating call window (see [voice.md](voice.md)).
- Tiles and CallFloat: a long press opens the user menu.
- Elsewhere: the Sidebar's Voice list + VoiceBar + mute/deafen in your panel, the green phone in ChatButtons, Call
  in the user menu, Voice volume in profiles, In voice in MeScreen.
- Status `detail` says why the mic/camera/share didn't start (`callError` under tiles). The voice bar shows
  `notice` (No answer/Declined) outside calls.
- `src/callStats.js` (`measureCall`, the web's measuring) every 5 s in voice.js -> `stats`, `pingSamples`,
  `server`. `src/ConnectionScreen.js`: SignalButton in the voice bar, the popup with react-native-svg's graph.
- `src/VoiceSettings.js`: Voice & audio (Choices, Others' volume, the mic test via expo-audio's recorder metering,
  which LiveKit's measuring can't do outside a call; the meter adds the mic volume in dB) and Video (front/back +
  a preview with react-native-webrtc's RTCView).

### Developing calls

`voice.ps1 -Dev` listens on 127.0.0.1:7880 (`adb reverse tcp:7880 tcp:7880`) and UDP 7882 on the LAN address
(same Wi-Fi; this PC's firewall allows livekit-server.exe).

## Push notifications (FCM)

Since 2026-10-15. See [notifications.md](notifications.md) for the server's push and Web Push.

### Firebase

- Firebase project `chatapp-e2944` (my Google account, Spark plan, no Analytics or Gemini).
- `mobile/google-services.json` (app.json `googleServicesFile`; it has both the release and dev apps) and the
  service account key `firebase-key.json` in the repo folder (config.py's `FIREBASE_KEY_FILE`), both git-ignored.
  The key goes with export/import/backup.ps1.
- The real server has had the key since 2026-10-15 (`C:\ChatApp\firebase-key.json`, the default path; checked
  2026-11-15). A new server gets it with the rest of the data (export/import).

### The server side

- `/push/fcm` stores the token in push_subscriptions as `fcm:<token>` (an upsert that keeps the mute).
- `send_push` sends data messages through `send_fcm` (FCM HTTP v1; the access token from an RS256 JWT we sign with
  `cryptography`, cached an hour; 404 deletes).
- `always=True` (phones only, ignoring looking/mute) for `stop_ringing`'s `call_end` (answer_call, ring_timeout,
  end_call). `/calls/decline`. "welcome" has `phone_push`.
- "read" (since 2026-10-16; FCM priority NORMAL): `on_phones` (memory) holds (user, chat) for every message/friend
  push a phone got. `clear_on_phones` sends "read" once that chat is seen elsewhere (join while looking, "looking"
  true on it; "friends" = channel None or accept/decline), and PushService cancels it (the icon's number is the sum
  of the notifications showing). The app clears "friends" itself on the People page (App.js).

### The push module

Our module `mobile/modules/push` (Kotlin; firebase-messaging 25.1.3, whose getToken/onNewToken are deprecated
since 25.1 for installation IDs but still work).

- `PushService`: Firebase's MESSAGING_EVENT.
- `Notifications.kt`: channels "messages" (with the ping) and "incoming_calls" (with the looping ring,
  FLAG_INSISTENT). MessagingStyle stacked per chat (tag = chat key) with avatars fetched with CookieManager's
  cookie. CallStyle with a full-screen intent. The icon badge is `setNumber` (messages stacked per chat; Android has
  no badge API).
- **`IncomingCallActivity`: the only thing ever shown over the lock screen (the user's rule: never the app itself;
  MainActivity showWhenLocked was tried and refused).** A small centred see-through window (picture, "x is
  calling…", Accept/Decline like IncomingCall.js, its own task). Accept = requestDismissKeyguard (unlock), then the
  app with "accept".
- `DeclineReceiver` POSTs /calls/decline with the cookie.
- `PushModule.kt`: the token; taps (`getInitialOpenAsync`/"onOpen" like shared-files: {channel, messageId, action
  open/ring/accept}); clearChat/clearCall/isCallShowing; canFillScreen (USE_FULL_SCREEN_INTENT, Android 14+).

### Late and silent call pushes (feedback #11, 2026-11-23)

Reported: the phone rang after the call was accepted on the PC, and only once the app was opened.

- How: FCM delivers late and in any order when Android holds an app's pushes back, so "call_end" could come
  before "call", which then rang for a call already answered.
- Why it was held back: Google deprioritizes HIGH pushes that often show nothing. With the Windows app open the
  phone got no "call" (send_push skips it) but still a silent HIGH "call_end" at every answer. Other apps (Discord,
  WhatsApp) don't need battery "Unrestricted", and ours shouldn't either.
- Server: push.py's `rang_phones` (memory, like `on_phones`) holds (user, chat) for each "call" a phone got;
  `stop_ringing_phones` sends "call_end" only to those.
- Phone (APK 1.0.12): `showCall` uses the push's `sentTime` (Google's clock): no ring once 30 s are
  gone (`setTimeoutAfter` = what's left), none if a "call_end" for that chat was sent later (`callEnded` keeps
  its time in SharedPreferences, `ended:<chat>`, so it outlives the app being stopped).
- Not testable black-box: the test server has no FCM. A fake FCM endpoint would be the way, if needed.

### The JS side

- `src/notifications.js`, `useNotifications` in App.js's Screen:
  - notification-settings.json; registers at every welcome; asks POST_NOTIFICATIONS the first time; mute ->
    /push/mute.
  - The ping (`assets/sounds/ping.wav`) on "unread"'s notify and new friend requests, but not in the background
    while push is on.
  - Clears a chat's notification when it's opened. `forgetThisPhone` at logout.
- `src/NotificationSettings.js`.
- App.js: `opened` -> go/jumpRequest/People's Requests tab. App.js asks `getInitialOpen` again at 0/0.3/1/2.5 s: at
  a cold start the Activity can still be missing (the answer was "none" and it opened #general; fixed 2026-10-16).
- `src/MessageBanner.js` (2026-10-16): the in-app banner, from notifications.js `banner` on "unread"'s notify and
  new requests, only while active and not quiet; setting `banner`. A tap -> App.js `goToNotice`; swipe up; 5 s.
- A tap that starts a closed app can't be tested in development builds (the dev launcher drops the extras, as
  with shares).
- `adb logcat -d` (read-only) showed what went wrong each time.

### Full screen notifications

Every new APK resets "Full screen notifications" (Android 14's USE_FULL_SCREEN_INTENT, for apps not from Play;
seen 2026-10-16; ordinary notifications survive). `src/FillScreenPrompt.js` (in Main) asks once per
runtimeVersion (`fill-screen-asked.txt`) when push is on and canFillScreen is false. Allow it ->
openFillScreenSettings.
