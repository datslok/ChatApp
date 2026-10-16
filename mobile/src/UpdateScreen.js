// "A new version of ChatApp": the popup when a newer APK is out (appUpdate.js), over everything, even
// the login screen. Update downloads it (a bar) and opens Android's installer; Later closes it (that
// version isn't offered again until the next start).
import { StyleSheet, Text, View } from 'react-native';
import { DialogButton, DialogButtons, Popup } from './MessageCard';
import { useApkUpdate } from './appUpdate';
import { useStyles } from './theme';

export default function UpdateScreen() {
  const styles = useStyles(makeStyles);
  const { offer, progress, problem, install, later } = useApkUpdate();
  if (!offer) return null;
  const downloading = progress !== null;
  return (
    <Popup icon="download" title="A new version" onClose={downloading ? () => {} : later}>
      <Text style={styles.text}>
        ChatApp {offer.version} is out. Updating takes a moment: Android asks to install it, then the app
        starts again.
      </Text>
      {downloading ? (
        <View style={styles.bar}><View style={[styles.done, { width: `${Math.round(progress * 100)}%` }]} /></View>
      ) : null}
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
      <DialogButtons>
        <DialogButton label="Later" secondary onPress={later} disabled={downloading} />
        <DialogButton label={downloading ? 'Downloading…' : 'Update'} onPress={install} disabled={downloading} />
      </DialogButtons>
    </Popup>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  text: { color: colors.text, fontSize: size(15.2), lineHeight: size(21) },
  // The web page's download bar: a dark track, the accent colour filling it.
  bar: { height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.bgDarkest, marginTop: 12 },
  done: { height: '100%', backgroundColor: colors.accent },
  problem: { marginTop: 10, color: colors.red, fontSize: size(13.6) },
});
