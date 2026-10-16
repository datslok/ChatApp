// "Calls on the lock screen": asking again for Android's "Full screen notifications" after an update.
//
// That permission is what lets a ringing call show its own small screen over the lock screen (who's
// calling, Accept, Decline: IncomingCallActivity). Since Android 14 only calling and alarm apps get it by
// themselves, and for an app that doesn't come from Google Play, every new APK puts it back to "not
// allowed" (seen on 2026-10-16: allowed on 1.0.4, gone after the update to 1.0.5). Messages and calls
// still come as ordinary notifications without it, so nothing tells you it's gone. So: the first time
// the app runs as a new version (or for the first time at all) with it off, this popup asks once. Not
// now is remembered for that version; Settings → Notifications keeps its own "Allow it" button.
import { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, Text } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Updates from 'expo-updates';
import { DialogButton, DialogButtons, Popup } from './MessageCard';
import { useStyles } from './theme';
import { canFillScreen, openFillScreenSettings } from '../modules/push';

// The version we last asked for (the APK's: expo-updates' runtimeVersion; "development" in a development
// build, which has none).
const askedFile = new File(Paths.document, 'fill-screen-asked.txt');
const VERSION = Updates.runtimeVersion || 'development';

function askedThisVersion() {
  try {
    return askedFile.exists && askedFile.textSync() === VERSION;
  } catch {
    return false;
  }
}

function rememberAsked() {
  try {
    if (!askedFile.exists) askedFile.create();
    askedFile.write(VERSION);
  } catch {}  // (just asked again at the next start)
}

// pushOn: Settings → Notifications' switch (no notifications on this phone: no calls to show either).
export default function FillScreenPrompt({ pushOn }) {
  const styles = useStyles(makeStyles);
  // null: closed; "update": it was asked about before (an earlier version); "first": never asked here.
  const [open, setOpen] = useState(null);

  useEffect(() => {
    // (Android 13 and older allow it by themselves: canFillScreen is then always true.)
    if (Platform.OS !== 'android' || !pushOn || askedThisVersion() || canFillScreen()) return;
    const kind = askedFile.exists ? 'update' : 'first';
    rememberAsked();  // asked now, whatever the answer: once per version
    setOpen(kind);
  }, [pushOn]);

  // Back from Android's settings page: allowed there, so the popup has done its job.
  useEffect(() => {
    if (!open) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && canFillScreen()) setOpen(null);
    });
    return () => subscription.remove();
  }, [open]);

  if (!open) return null;
  return (
    <Popup icon="phone" title="Calls on the lock screen" onClose={() => setOpen(null)}>
      <Text style={styles.text}>
        {open === 'update'
          ? 'Android turned this off with the update. Allow it again, so'
          : 'Android keeps this off until you allow it. Allow it, so'}
        {' '}a call can show who's calling, with Accept and Decline, while the phone is locked.
      </Text>
      <DialogButtons>
        <DialogButton label="Not now" secondary onPress={() => setOpen(null)} />
        <DialogButton label="Allow it" onPress={openFillScreenSettings} />
      </DialogButtons>
    </Popup>
  );
}

// (UpdateScreen's text.)
const makeStyles = (colors, size) => StyleSheet.create({
  text: { color: colors.text, fontSize: size(15.2), lineHeight: size(21) },
});
