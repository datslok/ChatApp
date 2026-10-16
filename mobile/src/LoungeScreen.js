// The Lounge page (the web page's #lounge-view): everyone in the Lounge as a tile (their camera, or their
// picture), and the buttons under them; "Join Lounge" while we're not in. Shown instead of a chat when
// Lounge is picked in the sidebar (App.js).
import { StyleSheet, Text, View } from 'react-native';
import { CallControls, JoinButton, TileGrid, callError, makeTiles } from './CallParts';
import { LOUNGE_ROOM } from './voice';
import { useStyles } from './theme';

// onUserMenu(id): a tile's long press.
export default function LoungeScreen({ connection, voice, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const inLounge = voice.roomName === LOUNGE_ROOM;
  const members = connection.voiceMembers[LOUNGE_ROOM] ?? [];
  const tiles = makeTiles({
    members, people: inLounge ? voice.callPeople() : [], meId: connection.me.id, inCall: inLounge && voice.connected,
  });
  return (
    <View style={styles.page}>
      {tiles.length ? (
        <TileGrid tiles={tiles} voice={voice} connection={connection} onUserMenu={onUserMenu} />
      ) : (
        <View style={styles.emptyArea}><Text style={styles.empty}>Nobody's in Lounge right now.</Text></View>
      )}
      {inLounge && callError(voice) ? <Text style={styles.error}>{callError(voice)}</Text> : null}
      <View style={styles.buttons}>
        {inLounge ? (
          <CallControls voice={voice} leaveLabel="Leave Lounge" />
        ) : (
          <JoinButton label="Join Lounge" icon="volume-2" onPress={() => voice.join(LOUNGE_ROOM)} />
        )}
      </View>
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // #lounge-view: a dark area, 16px around and between.
  page: { flex: 1, gap: 16, padding: 16, backgroundColor: colors.bgDeepest },
  emptyArea: { flex: 1, justifyContent: 'center' },
  empty: { textAlign: 'center', color: colors.textMuted, fontSize: size(16) },
  error: { textAlign: 'center', color: colors.red, fontSize: size(14) },
  buttons: { alignItems: 'center' },
});
