// The call banner at the top of a DM or group while it has a call (the web page's #call-panel, rooms.js
// renderCallPanel): a dark area with the tiles, the buttons under them, or "Join call" while we're not in
// it. In a DM always two tiles (us and them, faded while not there, "Calling…" while it rings); in a group
// everyone in the call. After our call ended unanswered: "Declined" or "No answer" for a few seconds.
// Its height: 40% of the screen, until it's dragged by the grip along its bottom edge (the web page's
// #call-resize); then that, kept in the voice settings for next time.
import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CallControls, JoinButton, TileGrid, callError, makeTiles } from './CallParts';
import { dmPartner } from './chats';
import { useStyles } from './theme';

// Is there anything to show for this chat?
export function hasCallBanner(chatKey, connection, voice) {
  return voice.roomName === chatKey || !!connection.dmCalls[chatKey]?.length || voice.notice?.channel === chatKey;
}

const MIN_HEIGHT = 160;  // the web page's MIN_CALL_HEIGHT

// onUserMenu(id): a tile's long press.
export default function CallBanner({ chatKey, connection, voice, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const { height } = useWindowDimensions();
  // The tallest it may be: the messages and the text box under it keep the rest (the web page's MIN_MESSAGES_HEIGHT).
  const maxHeight = Math.max(MIN_HEIGHT, height * 0.7);
  const clamp = (value) => Math.round(Math.max(MIN_HEIGHT, Math.min(maxHeight, value)));
  const saved = clamp(voice.settings.bannerHeight ?? height * 0.4);
  const [dragging, setDragging] = useState(null);  // the height while the grip is held, or null
  // (PanResponder is made once: its handlers read the newest values from here, see connection.js on refs.)
  const latest = useRef({});
  latest.current = { saved, clamp, voice };
  const start = useRef(0);
  const grip = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,  // (once dragging, it keeps the finger)
    onPanResponderGrant: () => {
      start.current = latest.current.saved;
      setDragging(start.current);
    },
    onPanResponderMove: (event, move) => setDragging(latest.current.clamp(start.current + move.dy)),  // down: taller
    onPanResponderRelease: (event, move) => {
      latest.current.voice.setSettings({ bannerHeight: latest.current.clamp(start.current + move.dy) });
      setDragging(null);
    },
    onPanResponderTerminate: () => setDragging(null),
  })).current;
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
    // 40% of the screen's height (#call-panel's 40vh) or as dragged; the messages under it give way.
    <View style={[styles.banner, { height: dragging ?? saved }]}>
      <TileGrid tiles={tiles} voice={voice} connection={connection} onUserMenu={onUserMenu} />
      {inCall && callError(voice) ? <Text style={styles.error}>{callError(voice)}</Text> : null}
      {inCall ? (
        <CallControls voice={voice} leaveLabel="End call" />
      ) : (
        <JoinButton label="Join call" icon="phone" onPress={() => voice.startCall(chatKey)} />
      )}
      {/* The grip: a short bar in the middle of the bottom edge, with room around it for a thumb. */}
      <View style={styles.grip} {...grip.panHandlers} accessibilityLabel="Drag to resize the call">
        <View style={[styles.gripBar, dragging !== null && styles.gripBarHeld]} />
      </View>
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // #call-panel: the tiles, then the buttons, 12px apart, 16px around, on the darkest colour.
  banner: { alignItems: 'center', gap: 12, padding: 16, paddingBottom: 20, backgroundColor: colors.bgDeepest },
  error: { color: colors.red, fontSize: size(14), textAlign: 'center' },
  // #call-resize: along the bottom edge, the whole width, a small rounded bar in the middle.
  grip: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 20, alignItems: 'center', justifyContent: 'center' },
  gripBar: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.textMuted, opacity: 0.6 },
  gripBarHeld: { backgroundColor: colors.accent, opacity: 1 },
  noticeBar: { padding: 12, alignItems: 'center', backgroundColor: colors.bgDeepest },
  notice: { color: colors.textMuted, fontSize: size(15) },
});
