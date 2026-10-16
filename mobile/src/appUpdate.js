// Updates of the app itself, the kind that needs a new APK (README, "Updating the phone app").
//
// Two kinds of update reach the phone app:
//   - JavaScript only (most changes): expo-updates fetches those by itself at every start, from the
//     server's /app-update, and uses them from the next start. Nothing to do here.
//   - Native code (a new module, a permission, the icon): that needs a new APK, which Android only
//     installs when the user says so. That's this file: at start, ask the server's
//     /releases/android.json which version is newest (again at reconnects and after calls, see
//     checkForApk); if it's newer than ours, offer it. "Update"
//     downloads the APK (with a bar) and hands it to Android's installer, which asks "Install?".
//
// Only in release builds: a development build gets its JavaScript from Metro and has no version.
import { useEffect, useRef, useState } from 'react';
import { fetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import * as Updates from 'expo-updates';
import { SERVER } from './config';
import { openFile } from './files';

// Is version a newer than b? ("1.0.10" is newer than "1.0.9": compared number by number.)
function isNewer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

// Asking again: at the start, and (App.js) at every connect, since a new release comes with a server
// restart that makes us reconnect, and after leaving a call, like the Windows app. Never in a call:
// App.js says when we're in one (setApkCheckPaused), and the offer waits until it's over.
let checkListener = null;
let paused = false;
let waitingCheck = false;  // asked while paused: check as soon as we aren't

export function checkForApk() {
  if (paused) waitingCheck = true;
  else checkListener?.();
}

export function setApkCheckPaused(on) {
  paused = on;
  if (!on && waitingCheck) {
    waitingCheck = false;
    checkListener?.();
  }
}

// {offer: {version, apk} or null, progress: 0..1 while downloading (else null), problem, install, later}
export function useApkUpdate() {
  const [offer, setOffer] = useState(null);
  const [progress, setProgress] = useState(null);
  const [problem, setProblem] = useState('');
  // The version Later was pressed for: not offered again until the next start (a newer one is).
  // (A ref: the check reads it, and nothing needs redrawing when it changes.)
  const declined = useRef(null);

  useEffect(() => {
    // runtimeVersion: this APK's version (app.json's "version", see its runtimeVersion policy).
    if (__DEV__ || !Updates.runtimeVersion) return;
    function check() {
      fetch(`${SERVER}/releases/android.json`, { headers: { 'Cache-Control': 'no-cache' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((latest) => {
          if (latest?.apk && isNewer(latest.version, Updates.runtimeVersion) && latest.version !== declined.current) {
            setOffer((old) => old ?? latest);  // (one already showing stays as it is)
          }
        })
        .catch(() => {});  // (offline: the next check)
    }
    checkListener = check;
    checkForApk();
    return () => {
      checkListener = null;
    };
  }, []);

  // Download the APK into the app's cache (emptied at every start, files.js clearOldCopies), then open
  // it: Android's installer takes over. The first time, Android asks whether ChatApp may install apps
  // at all ("Install unknown apps"); then "Install?".
  async function install() {
    setProblem('');
    setProgress(0);
    try {
      const response = await fetch(`${SERVER}/releases/${encodeURIComponent(offer.apk)}`);
      if (!response.ok) throw new Error();
      const size = Number(response.headers.get('content-length')) || 0;
      const folder = new Directory(Paths.cache, 'apk');
      folder.create({ intermediates: true, idempotent: true });
      const file = new File(folder, offer.apk);
      file.create({ overwrite: true });
      const handle = file.open();
      let received = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          handle.writeBytes(value);
          received += value.length;
          if (size) setProgress(Math.min(1, received / size));
        }
      } finally {
        handle.close();
      }
      setProgress(null);
      if (!(await openFile(file.contentUri, 'application/vnd.android.package-archive'))) throw new Error();
    } catch {
      setProgress(null);
      setProblem("Couldn't download the update. Try again in a moment.");
    }
  }

  function later() {
    declined.current = offer?.version ?? null;
    setOffer(null);
  }

  return { offer, progress, problem, install, later };
}
