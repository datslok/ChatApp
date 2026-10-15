// The floating call window (the web page's #call-float, rooms.js): while we're in a call but looking at
// something else (another chat, the People page, a DM while in the Lounge), whoever is talking as a small
// tile in a corner (their camera if it's on), so the call never goes out of sight. A tap goes back to the
// call. Drag it anywhere: let go and it slides into the nearest corner, and stays there (voice settings'
// floatCorner).
//
// The dragging is React Native's own: PanResponder (touch tracking, as in Slider.js) moves an Animated
// value (as in Drawer.js). It only takes the touch once the finger has moved 5 px, so a plain tap still
// reaches the tile's own Pressable (the tap that opens the call).
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, View } from 'react-native';
import { CallTile } from './CallParts';
import { dmPartner } from './chats';
import { LOUNGE, LOUNGE_ROOM } from './voice';
import { useStyles } from './theme';

const WIDTH = 160;  // (the web page's phone size: chat.css, #call-float)
const HEIGHT = (WIDTH * 9) / 16;
const MARGIN = 16;

// view: the chat or page on screen. bottomGap: room to leave at the bottom (the text box). onOpen(key):
// open the call's page.
export default function CallFloat({ connection, voice, view, bottomGap, onOpen }) {
  const styles = useStyles(makeStyles);
  const [area, setArea] = useState(null);  // the space it moves in: {width, height}
  const position = useRef(new Animated.ValueXY()).current;  // its top left corner, in that space
  const lastSpeaker = useRef(null);  // the last other person who talked
  const latest = useRef({});
  const dragging = useRef(false);

  const page = voice.roomName === null ? null : voice.roomName === LOUNGE_ROOM ? LOUNGE : voice.roomName;
  const show = page !== null && view !== page;
  const corner = voice.settings.floatCorner;

  // Where a corner is, in the space it has.
  function pointFor(which, space = area) {
    const [vertical, horizontal] = which.split('-');
    return {
      x: horizontal === 'left' ? MARGIN : space.width - WIDTH - MARGIN,
      y: vertical === 'top' ? MARGIN : space.height - HEIGHT - MARGIN - bottomGap,
    };
  }
  latest.current = { area, corner, pointFor, setSettings: voice.setSettings };

  // In its corner (again) whenever the corner, the space or the bottom gap changes, unless held.
  useEffect(() => {
    if (area && !dragging.current) position.setValue(pointFor(corner));
  }, [area, corner, bottomGap]);

  // Made once (see Slider.js): the handlers read the newest values from `latest`.
  const pan = useRef(PanResponder.create({
    // "Capture": asked before the tile's Pressable (which took the touch when it went down), so the
    // window takes it over once the finger moves; a tap that doesn't move stays the Pressable's.
    onMoveShouldSetPanResponderCapture: (event, move) => Math.hypot(move.dx, move.dy) > 5,
    onPanResponderTerminationRequest: () => false,  // (once dragging, it keeps the finger)
    onPanResponderGrant: () => {
      dragging.current = true;
    },
    onPanResponderMove: (event, move) => {
      const { corner: from, pointFor: point, area: space } = latest.current;
      const start = point(from, space);
      position.setValue({ x: start.x + move.dx, y: start.y + move.dy });
    },
    onPanResponderRelease: (event, move) => {
      const { corner: from, pointFor: point, area: space, setSettings } = latest.current;
      const start = point(from, space);
      // The nearest corner: which half of the space its middle ended up in, across and down.
      const middleX = start.x + move.dx + WIDTH / 2;
      const middleY = start.y + move.dy + HEIGHT / 2;
      const next = `${middleY < space.height / 2 ? 'top' : 'bottom'}-${middleX < space.width / 2 ? 'left' : 'right'}`;
      Animated.timing(position, {
        toValue: point(next, space), duration: 200, easing: Easing.out(Easing.ease), useNativeDriver: true,
      }).start(() => {
        dragging.current = false;
      });
      setSettings({ floatCorner: next });
    },
    onPanResponderTerminate: () => {
      dragging.current = false;
    },
  })).current;

  if (!show) return null;

  // Who it shows: whoever talked last (not us), else the DM's other person, else anyone else there, else us.
  const meId = connection.me.id;
  const people = voice.callPeople();
  const others = people.filter((person) => !person.isMe);
  for (const id of voice.speaking) if (id !== meId) lastSpeaker.current = id;
  let id = others.some((person) => person.id === lastSpeaker.current) ? lastSpeaker.current : null;
  id ??= dmPartner(voice.roomName, meId) ?? others[0]?.id ?? meId;
  const person = people.find((p) => p.id === id);
  const members = (voice.roomName === LOUNGE_ROOM ? connection.voiceMembers[LOUNGE_ROOM] : connection.dmCalls[voice.roomName]) ?? [];
  const state = members.find((member) => member.id === id) ?? {};
  const ringing = voice.outgoing === voice.roomName && !person;
  const tile = {
    key: `float:${id}`, id, isMe: id === meId, video: person?.camera ?? null,
    muted: state.muted, deafened: state.deafened, away: !person, note: ringing ? 'Calling…' : '',
  };

  return (
    // The space it moves in: the whole content area, letting touches through to what's under it
    // ("box-none": only its children, the window, take touches).
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" onLayout={(event) => setArea(event.nativeEvent.layout)}>
      {area ? (
        <Animated.View style={[styles.float, { transform: position.getTranslateTransform() }]} {...pan.panHandlers}>
          <CallTile
            tile={tile} user={connection.users[id]} width={WIDTH} speaking={voice.speaking.has(id)}
            facing={voice.facing} onPress={() => onOpen(page)}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  // #call-float: rounded, a shadow (elevation: Android's), over the chat.
  float: { position: 'absolute', top: 0, left: 0, borderRadius: 12, elevation: 8, backgroundColor: colors.bgPanel },
});
