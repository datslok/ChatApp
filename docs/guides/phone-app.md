# The phone app

The chat installs on phones as a **PWA** ("progressive web app"): its own icon on the home screen and
its own window without the browser's address bar, straight from the website, with no app store. It's
the same page as in the browser, so it's always up to date. What makes it installable:
`static/manifest.json` (its name, icons and colours), the icons in `static/icons/` (made by
`python tools\make_pwa_icons.py` from the app icon) and a service worker, `static/sw.js`.

To install it: open the chat on the phone. A banner above the messages offers **Install** (Chrome on
Android opens its install dialog), and in the installed app then **Turn on** for notifications. By hand:
Chrome's ⋮ menu, **Install app** (or "Add to Home screen"); on an **iPhone**: Safari, the Share
button, **Add to Home Screen**.

**Notifications while the chat is closed** (push notifications): Settings → Notifications → "Notifications
on this device when the chat is closed", on each phone (or browser) that should get them. They come for
DMs, mentions and calls, only while you're not looking at the chat on any device, and follow "Mute
notifications". The server needs the VAPID keys in `.env` for this (see "The server: settings"). On an
iPhone they only work in the installed app (Add to Home Screen), not in Safari itself.

If the microphone or camera "isn't allowed" although the site allows it, Android may be blocking the
browser itself: Settings, Apps, Chrome (and the installed ChatApp), Permissions, Microphone and Camera.

Calls keep going with the screen off on most Android phones. If a call stops when the phone is in a
pocket, set the browser's battery use to "Unrestricted" in Android's app settings. iPhones often stop
web pages when they're locked, calls included.

## The native app

A real Android app in `mobile\`, made with [React Native](https://reactnative.dev/) and
[Expo](https://expo.dev/), talking to the same server (the PWA above still works too). Friends install
it from `/download` ("Releasing the phone app" below). To work on it:

1. Install [Node.js](https://nodejs.org/) (LTS), [Android Studio](https://developer.android.com/studio)
   (`winget install Google.AndroidStudio`; open it once and let it install the Android SDK) and a
   Java 17 (`winget install Microsoft.OpenJDK.17`; newer Java versions break the build).
2. Set two user environment variables (Windows search, "Edit environment variables for your account"):
   `ANDROID_HOME` to `%LOCALAPPDATA%\Android\Sdk` and `JAVA_HOME` to the Java 17 folder (in
   `C:\Program Files\Microsoft\`), and add `%LOCALAPPDATA%\Android\Sdk\platform-tools` to `Path`.
3. On the phone: turn on Developer options (Settings, About phone, Software information, tap
   "Build number" seven times), then USB debugging in them. Plug it in and allow the PC.
   `adb devices` should list it. If it lists nothing on a Samsung phone, Windows is missing Samsung's
   ADB driver: install "SAMSUNG Electronics Co., Ltd. USB Driver Update" from Windows Update (Settings,
   Windows Update, Advanced options, Optional updates; when it isn't listed there, take the driver from
   [Samsung's site](https://developer.samsung.com/android-usb-driver)), then plug the phone in again.
4. In PowerShell:

```powershell
cd mobile
npm install
npx expo run:android
```

The first build downloads a lot (Gradle, the NDK) and takes a while. It installs a **development
build** on the phone: the native part is built once, and the JavaScript comes live from **Metro**
on your PC, so saving `App.js` changes the app within a second. The phone needs to be on the same
network as the PC. Shake the phone for the developer menu (Reload, DevTools).

The app talks to the server named in `mobile\src\config.js`: your development server
(`.\start.ps1`) by default. That one only listens on your PC, so with the phone plugged in, run
this once (again after replugging) to make the phone's own `localhost:8001` lead to the PC's:

```powershell
adb reverse tcp:8001 tcp:8001
```

Log in with an account on the development server (create one in the browser at
http://localhost:8001; the email verification link is printed in the server's window).

To try calls (the Lounge, DM and group calls) from the phone, start the development LiveKit too
(`.\voice.ps1 -Dev`) and pass its signalling port through as well:

```powershell
adb reverse tcp:7880 tcp:7880
```

The sound itself goes over UDP straight to the PC's address on your home network (port 7882), so the
phone must be on the same Wi-Fi, and Windows Firewall must let `livekit-server.exe` in (Windows asks
the first time it runs; if you said no, allow it under "Allow an app through Windows Firewall"). A call
keeps going with the phone locked: the app then shows an "In a call" notification with Hang up.
The call sounds (ringing, joining, leaving) are WAV files made from the web page's tones by
`python tools\make_call_sounds.py`; the ones played during a call go through Android's call sound
channel, so they don't wait while the phone switches into call mode. The app's noise suppression ("On") is RNNoise, compiled
into the app's own native code along with everything else; its source is in
`mobile\modules\call-service\android\src\main\cpp\`, put there by `python tools\get_rnnoise.py`.

### Push notifications in the app

The app gets notifications through **Firebase Cloud Messaging** (FCM), Google's push service, which
every Android phone with Google Play keeps a connection to. It's free. You need a Firebase project:

1. At [console.firebase.google.com](https://console.firebase.google.com): **Create a project** (Google
   Analytics can be off).
2. **Add app → Android**, with the app's package name (`android.package` in `mobile\app.json`), and once
   more with that name plus `.dev` (development builds are an app of their own, "ChatApp Dev", so they
   can sit next to the real one: `mobile\plugins\dev-variant.js`). Then download **google-services.json**
   (it covers both) into `mobile\` (it says which project the app belongs to; git ignores it). Skip the
   rest of that page's steps: Expo does them.
3. **Project settings → Service accounts → Generate new private key**. Save it as **firebase-key.json** in
   the chat's folder, on your PC (for `start.ps1`) and on the server, where the chat reads it at start:

```powershell
scp firebase-key.json chatserver:C:/ChatApp/firebase-key.json
ssh chatserver "Stop-ScheduledTask ChatApp; Start-ScheduledTask ChatApp"
```

   It lets whoever has it send notifications as your app: never commit it (git ignores it), keep it
   out of chats and email. `export.ps1` and the nightly backup take it along with `.env`.
4. `npx expo prebuild --clean`, then `npx expo run:android`: the app now has Firebase in it.

The app turns notifications on at its first start (Android asks whether it may); Settings →
Notifications turns them off and on, mutes them for a while, and sets the sound while the app is open.
DMs, mentions and friend requests come stacked per chat with the sender's picture; a call rings until
it's answered, with Decline and Accept. With the phone locked, a call opens a small call screen (who's
calling, Decline, Accept; if Android allows "Full screen notifications": Settings → Notifications says so).
That screen is all that ever shows over the lock screen, never the chat: Accept asks to unlock first.
Like the web page's, notifications only come while you're not looking at the chat on any device, never
on Do Not Disturb.

### Releasing the phone app

Friends get the app from `/download` (on an Android phone it shows the Android app): an APK, the app's
install file, straight from your server, no Play Store. After that it updates itself, in two ways:

- **JavaScript** (most changes: screens, buttons, behaviour): `.\scripts\app-update.ps1` (which also deletes
  all but the newest 3 updates, here and on the server, so `releases\` doesn't keep growing). It restarts the
  chat at the end, so every open app reconnects, fetches the new bundle
  ([expo-updates](https://docs.expo.dev/versions/latest/sdk/updates/), from your server's `/app-update`)
  and switches to it in a second, like the desktop app does, as soon as nothing would be lost (not in a
  call, no files waiting, no popup open; the open chat and half-written messages stay). Closed apps get
  it when they start. Nothing to tap.
- **Native code** (a module or package with native code, a permission, the icon, `app.json`): those need a
  new APK. `.\scripts\app-release.ps1` raises the version, builds and signs the APK and puts it on the
  server; the app then offers "A new version" (at its next start or reconnect, or after a call), downloads it
  and opens Android's installer. `app-update.ps1` refuses when native code changed since the last APK, and says so.

New JavaScript only goes to phones whose APK it was made for (the app's version is its "runtime
version"), so an update can never break an older app.

Once, before the first release:

1. Your server's address in `mobile\src\config.js` (`SERVER`, for release builds) and in `mobile\app.json`
   (`updates.url`: the same address with `/app-update`; and `android.intentFilters`' `host`: just the name,
   like `chat.example.com`; it's there twice). That last one makes links to your chat
   (`https://chat.example.com/?channel=...`) and password reset links (`/reset?token=...`, so the whole reset
   happens in the app) open in the app ("App Links"). Android only allows it if your server agrees, at
   `/.well-known/assetlinks.json`, which it makes from the package and key fingerprint that
   `app-release.ps1` writes into `releases\android.json`. Android checks it when the app is installed, so
   it works from the first APK on (`adb shell pm get-app-links no.datslok.chat` on a phone shows
   "verified").
2. The **release signing key**. Android only installs an update over an app signed with the same key,
   so every APK is signed with this one, kept for good: **losing it means everyone uninstalling the app
   and installing it again.** Keep a copy of both files below somewhere safe outside your PC.

```powershell
New-Item -ItemType Directory $HOME\.chatapp-keys -Force
$java = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
& "$java\bin\keytool.exe" -genkeypair -storetype PKCS12 -keystore $HOME\.chatapp-keys\android-release.jks -alias chatapp -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=ChatApp"
```

   It asks for a password. Then put these four lines in `%USERPROFILE%\.gradle\gradle.properties` (your
   user folder, never in git), with your path and password; `mobile\plugins\release-signing.js` reads them:

```
CHATAPP_RELEASE_STORE_FILE=C:/Users/you/.chatapp-keys/android-release.jks
CHATAPP_RELEASE_STORE_PASSWORD=the password
CHATAPP_RELEASE_KEY_ALIAS=chatapp
CHATAPP_RELEASE_KEY_PASSWORD=the password
```

Then, for each release (with everything in `mobile\` committed):

```powershell
.\scripts\app-release.ps1    # native changes: a new APK (also the very first release)
.\scripts\app-update.ps1     # JavaScript only
```

Development builds (`npx expo run:android`) are "ChatApp Dev" on the phone, next to the real app, and
talk to your development server; release builds talk to the real one.

Later, when only JavaScript changed, `npx expo start` is enough. Run `npx expo run:android` again
after adding a package with native code. Add packages with `npx expo install <name>` (not
`npm install`), so you get the version that matches Expo. The `android\` folder is generated from
`app.json` (and not in git): never edit it by hand. After changing `app.json` (or a plugin in
`mobile\plugins\`, or a module in `mobile\modules\`), run `npx expo prebuild --clean` first, which makes
it again, then `npx expo run:android`. If prebuild says `EBUSY: resource busy or locked` about
`android`, the adb server that `run:android` started is still standing in that folder: run
`adb kill-server` (and `adb reverse tcp:8001 tcp:8001` again afterwards).
