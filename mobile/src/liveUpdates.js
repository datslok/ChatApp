// New JavaScript while the app is open, like the desktop app's reload (core.js, reloadIfOutdated).
//
// expo-updates fetches a new bundle by itself at start, but only uses it from the next start. This
// asks the server (/app-update) whenever we connect (a deploy restarts the server, so every open app
// reconnects and asks at once) and whenever the app comes back on screen; downloads a newer bundle;
// and switches to it (Updates.reloadAsync: a restart of the JavaScript, a second or so) as soon as
// that's safe: not in or ringing for a call, no files in a tray, no popup open. Until then it waits,
// and switches the moment it is (checked after every redraw).
//
// What's on screen goes along: the chat that's open and every half-written message are written to a
// file just before, and read back at the start (`restored`), like the desktop app's drafts.
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Updates from 'expo-updates';

const stateFile = new File(Paths.cache, 'reload-state.json');

// The safety catch. Just before switching, the update we switch to is written here; after the restart,
// expo-updates says which one is running (Updates.updateId). The same: it worked, the file goes. Not: that
// update didn't take, and it's never switched to again (the file stays, so later starts skip it too).
// Without this, an update the same as the APK's own bundle made phones reload over and over (2026-11-23):
// nothing to download, the restart came back to the APK's bundle, which isn't the update, so it switched
// again. (In documents, not the cache, which Android may empty.)
const triedFile = new File(Paths.document, 'tried-update.txt');
const sameId = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// The id of an update that didn't take, or null.
const brokenUpdate = (() => {
  try {
    if (!triedFile.exists) return null;
    const tried = triedFile.textSync().trim();
    if (sameId(tried, Updates.updateId)) {
      triedFile.delete();  // it's running: all good
      return null;
    }
    return tried;
  } catch {
    return null;
  }
})();

// What was on screen before the last switch, {view, drafts}, or null. Read once, when the app starts,
// and removed (a later ordinary start begins afresh).
export const restored = (() => {
  try {
    if (!stateFile.exists) return null;
    const saved = JSON.parse(stateFile.textSync());
    stateFile.delete();
    return saved;
  } catch {
    return null;
  }
})();

// connection: useConnection()'s (a new `me` = connected). safe: may we switch right now? save(): what to
// keep, {view, drafts}. (Release builds only: a development build's JavaScript comes from Metro.)
export function useLiveUpdates({ connection, safe, save }) {
  const latest = useRef({});
  latest.current = { safe, save };
  const ready = useRef(false);     // a newer bundle is downloaded and waiting
  const checking = useRef(false);  // (one check at a time)
  const readyId = useRef(null);    // the waiting bundle's update id

  async function check() {
    if (__DEV__ || checking.current || ready.current) return;
    checking.current = true;
    try {
      const result = await Updates.checkForUpdateAsync();
      const id = result.manifest?.id;
      if (result.isAvailable && !sameId(id, brokenUpdate) && !sameId(id, Updates.updateId)) {
        await Updates.fetchUpdateAsync();
        readyId.current = id;
        ready.current = true;
        switchIfSafe();
      }
    } catch {
      // (Offline, or the start's own download is busy: the next connect or return to the app asks again.)
    } finally {
      checking.current = false;
    }
  }

  function switchIfSafe() {
    if (!ready.current || !latest.current.safe) return;
    ready.current = false;  // (once)
    try {
      if (!stateFile.exists) stateFile.create();
      stateFile.write(JSON.stringify(latest.current.save()));
    } catch {}
    try {
      if (!triedFile.exists) triedFile.create();
      triedFile.write(readyId.current ?? '');
    } catch {}
    Updates.reloadAsync().catch(() => {
      ready.current = true;  // (didn't work: try again at the next safe moment)
    });
  }

  useEffect(() => {
    check();
  }, [connection.me]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => subscription.remove();
  }, []);
  // After every redraw: did it just become safe (the call ended, the tray was sent)?
  useEffect(switchIfSafe);
}
