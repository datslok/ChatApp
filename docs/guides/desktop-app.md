# The desktop app

Optional: everything works in the browser. The Windows app (`desktop\`, made with
[Tauri](https://tauri.app/)) is a small window around your site, with real Windows notifications,
links opening in the default browser, automatic updates, and (Settings → App behaviour, switched on the first time the app runs)
starting when Windows starts. It also registers `chatapp://` links with Windows: an email's password reset
link opens in the browser (Windows only gives `https://` links to browsers), and that page's
"Open in the Windows app" button hands it to the app, which does the reset in its own window. Changes to the chat reach it through the
site; a new app version is only needed when the app itself changes (its Rust code, plugins, the icon).
People download it from `https://chat.example.com/download`.

Building it needs [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/). In `desktop\`,
`npm install` once, then `npm run tauri dev` opens the app straight from the code.

## Making it yours

The app in this repository points at the original chat and is signed with its key. For your own:

1. **Your address**, in three places: `desktop\src-tauri\tauri.conf.json` (`app.windows[0].url`, and
   `plugins.updater.endpoints`: `https://chat.example.com/releases/latest.json`) and
   `desktop\src-tauri\capabilities\default.json` (`remote.urls`: `https://chat.example.com/*`).
2. **Your own app id**: `identifier` in `tauri.conf.json` (like `com.example.chat`), so it doesn't
   collide with the original's app on someone's PC.
3. **Your own signing key.** Updates are only installed if they're signed with the key the app was
   built with. Make one (press Enter twice when it asks for a password, for none), and put the
   **public** key it prints in `tauri.conf.json` (`plugins.updater.pubkey`):
   ```powershell
   npm run tauri signer generate -- -w "$HOME\.tauri\chatapp.key"
   ```
   Keep the private key safe and never commit it: without it, installed apps can't update any more,
   and everyone would have to reinstall by hand.
4. **Your own icon** (see [Changing the icon](#changing-the-icon)).
5. Optionally **your own link scheme**: `plugins.deep-link.desktop.schemes` in `tauri.conf.json` (`chatapp`,
   for `chatapp://` links; two apps with the same one would fight over it). Change it in
   `static\reset.html` too (`offerWindowsApp`).

## Releasing a version

Everyone's app installs a new version by itself (open apps when they reconnect after the server
restarts, or after their call; the others at their next start).

1. Raise `"version"` in `desktop\src-tauri\tauri.conf.json` (like 0.1.8 → 0.1.9).
2. Build and sign it, in `desktop\`:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "$HOME\.tauri\chatapp.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```
3. Copy `ChatApp_<version>_x64-setup.exe` and its `.sig` from
   `desktop\src-tauri\target\release\bundle\nsis\` into `releases\` (in the project folder).
4. Write `releases\latest.json` (what the apps and the download page read):
   ```json
   {
     "version": "0.1.9",
     "platforms": {
       "windows-x86_64": {
         "url": "https://chat.example.com/releases/ChatApp_0.1.9_x64-setup.exe",
         "signature": "the whole contents of the .sig file"
       }
     }
   }
   ```
5. Commit the version change, then put it on the server:
   ```powershell
   git add desktop; git commit -m "Desktop app 0.1.9: ..."
   .\scripts\release-upload.ps1
   ```
   It copies the installer and `latest.json` into the server's `releases\`, deletes the older versions
   there and in your own `releases\` (the apps only ever update upwards; the nightly backup keeps every
   version), and then runs `deploy.ps1`, whose restart makes open apps look for the new version.

**Testing the update window** (what people see while the app updates): in `desktop\`, make a file
`pretend.json` containing `{"version": "0.1.0"}`, then `npm run tauri dev -- --config pretend.json`.
The app then believes it's old, finds the live version, and updates to it.

## Changing the icon

Put the new picture (a 1024×1024 PNG) in `icon\`, then in `desktop\`:
`npm run tauri icon ../icon/<file>.png` (delete the `android`, `ios`, `Square*`/`StoreLogo` and
`icon.icns` files it also makes), copy `desktop\src-tauri\icons\icon.ico` to `static\favicon.ico`
(the browser tab's icon; also raise the number in the pages' `favicon.ico?v=` links, so browsers fetch
the new one instead of keeping the old one for a day), point `tools\make_installer_images.py` at the
new file (its `ICON` line), run `python tools\make_installer_images.py` (the installer's pictures and the
update window's cat), and release a new version. The phone app's icons: `python tools\make_pwa_icons.py`
(it reads the same `ICON` file name; change it there too; its `DRAWING`, the line drawing on transparency, also
makes the notifications' small icon, so that wants a drawing that reads as a white shape), then a new APK.

## The old icon is still showing after an update

Windows keeps a cache of every icon it has shown, and doesn't always notice when a program's icon
changes: the taskbar, Start menu or desktop can keep showing the old one after the app has updated.
**`scripts\refresh-icons.bat`** fixes that: double-click it. It stops Explorer (the taskbar and desktop
disappear for a moment; nothing else closes), deletes the icon cache, and starts Explorer again, which
then reads every icon fresh. If a program pinned to the taskbar still shows its old icon, unpin it and
pin it again.

It's a plain `.bat` file, so you can send it to the people using your chat (in the chat itself, for
example) and they can run it with a double-click. Downloaded files make Windows ask first: choose
**Run** (or **More info → Run anyway**).

## The camera is black (or snowy) in the app

If the camera shows only black, or flickers into snow like an old TV, in the app (Settings → Video →
Test camera, and in calls) while it works in Edge, Discord and Windows' Camera app, an antivirus with
webcam protection is probably blocking the app: Malwarebytes did this, and Avast's Webcam Shield does
the same to programs it doesn't know. It doesn't refuse the camera outright (which would show an error
under the button), it just hands over an empty picture. Allow ChatApp in the antivirus's settings, then
quit the app completely (also from the tray) and start it again.
