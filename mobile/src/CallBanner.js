// The call banner at the top of a DM or group while it has a call (the web page's #call-panel, rooms.js
// renderCallPanel): a dark area with the tiles, the buttons under them, or "Join call" while we're not in
// it. In a DM always two tiles (us and them, faded while not there, "Calling…" while it rings); in a group
// everyone in the call. After our call ended unanswered: "Declined" or "No answer" for a few seconds.
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CallControls, JoinButton, TileGrid, makeTiles } from './CallParts';
import { dmPartner } from './chats';
import { useStyles } from './theme';

// Is there anything to show for this chat?
export function hasCallBanner(chatKey, connection, voice) {
  return voice.roomName === chatKey || !!connection.dmCalls[chatKey]?.length || voice.notice?.channel === chatKey;
}

export default function CallBanner({ chatKey, connection, voice }) {
  const styles = useStyles(makeStyles);
  const { height } = useWindowDimensions();
  const meId = connection.me.id;
  const inCall = voice.roomName === chatKey;
  const members = connection.dmCalls[chatKey] ?? [];
  const people = inCall ? voice.callPeople() : [];
  const partner = dmPartner(chatKey, meId);

  let tiles;
  if (partner !== null) {
    // A DM: us and them. They're there if LiveKit has them (in the call) or the server lists them.
    const there = inCall ? people.some((person) => person.id === partner) : members.some((member) => member.id === partner);
    const ringing = voice.outgoing === chatKey;
    const list = [{ id: meId, ...(members.find((m) => m.id === meId) ?? { muted: voice.muted, deafened: voice.deafened }) }];
    list.push(members.find((m) => m.id === partner) ?? { id: partner });
    tiles = makeTiles({
      members: list, people, meId, inCall: inCall && voice.connected,
      extra: (id) => ({
        away: id === meId ? !inCall : !there,
        note: id === partner && ringing && !there ? 'Calling…' : '',
      }),
    });
  } else {
    // A group: everyone in the call, and us (faded while we're not in it).
    tiles = makeTiles({
      members, people, meId, inCall: inCall && voice.connected, alwaysMe: true,
      extra: (id) => ({ away: id === meId && !inCall }),
    });
  }

  const notice = voice.notice?.channel === chatKey && !inCall && !members.length ? voice.notice.text : null;
  if (notice) {
    return <View style={styles.noticeBar}><Text style={styles.notice}>{notice}</Text></View>;
  }

  return (
    // 40% of the screen's height (#call-panel's 40vh), the messages under it give way.
    <View style={[styles.banner, { height: Math.max(160, height * 0.4) }]}>
      <TileGrid tiles={tiles} voice={voice} connection={connection} />
      {inCall && voice.status?.kind === 'error' ? <Text style={styles.error}>{voice.status.text}</Text> : null}
      {inCall ? (
        <CallControls voice={voice} leaveLabel="End call" />
      ) : (
        <JoinButton label="Join call" icon="phone" onPress={() => voice.startCall(chatKey)} />
      )}
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // #call-panel: the tiles, then the buttons, 12px apart, 16px around, on the darkest colour.
  banner: { alignItems: 'center', gap: 12, padding: 16, backgroundColor: colors.bgDeepest },
  error: { color: colors.red, fontSize: size(14) },
  noticeBar: { padding: 12, alignItems: 'center', backgroundColor: colors.bgDeepest },
  notice: { color: colors.textMuted, fontSize: size(15) },
});
