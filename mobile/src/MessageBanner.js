// The banner at the top for a DM, mention or friend request while the app is open (notifications.js
// decides when): the web page's desktop notification, drawn by the app itself, since Android's own
// notifications only come while the app is closed. The sender's picture, "kari in #memes" (only "kari"
// in a DM), and the start of the message. A tap goes there; swiping it up or 5 seconds put it away.
//
// Animated moves it without React redrawing anything: `offset` is a number the native side follows
// (0: in place; minus its height: above the top, out of sight).
import { useEffect, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from './people';
import { chatLabel, dmPartner } from './chats';
import { tokensToCodes } from './format';
import { useStyles } from './theme';

const SHOWN_FOR = 5000;  // ms
const HIDDEN = -120;     // px: enough to be out of sight above the top

// banner: notifications.js's (or null). onOpen(banner): tapped. onClose: gone.
export default function MessageBanner({ banner, connection, onOpen, onClose }) {
  const styles = useStyles(makeStyles);
  const offset = useRef(new Animated.Value(HIDDEN)).current;
  const latest = useRef({});
  latest.current = { onClose };

  // Slide away, then tell App.js it's gone.
  function hide() {
    Animated.timing(offset, { toValue: HIDDEN, duration: 200, useNativeDriver: true }).start(() => latest.current.onClose());
  }

  // A new banner (a new `at`): slide in, and away again after SHOWN_FOR.
  useEffect(() => {
    if (!banner) return;
    Animated.timing(offset, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    const timer = setTimeout(hide, SHOWN_FOR);
    return () => clearTimeout(timer);
  }, [banner?.at]);

  // Swiping it up: it follows the finger (never down past its place); let go after 30 px up, it goes.
  // Only a real move takes the touch, so a tap still reaches the Pressable inside.
  const swipe = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (event, move) => Math.abs(move.dy) > 6,
    onPanResponderMove: (event, move) => offset.setValue(Math.min(0, move.dy)),
    onPanResponderRelease: (event, move) => {
      if (move.dy < -30) hide();
      else Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;

  if (!banner) return null;
  const { users, me } = connection;
  const user = users[banner.user_id];
  const name = user?.name ?? banner.name ?? 'Someone';
  let title;
  let text;
  if (banner.request) {
    title = name;
    text = '👋 sent you a friend request';
  } else {
    title = dmPartner(banner.channel, me.id) !== null ? name : `${name} in ${chatLabel(banner.channel, connection)}`;
    text = tokensToCodes(banner.text ?? '', users, connection.emoji);  // <@2> -> @kari, <:17> -> :pog:
  }

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY: offset }] }]} {...swipe.panHandlers}>
      <Pressable
        onPress={() => {
          onOpen(banner);
          hide();
        }}
        style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
      >
        <Avatar user={user} name={name} size={36} />
        <View style={styles.words}>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          {text ? <Text numberOfLines={2} style={styles.text}>{text}</Text> : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // Over the chat, 8px from the top and sides; above everything in the chat area (zIndex/elevation).
  wrap: { position: 'absolute', top: 8, left: 8, right: 8, zIndex: 20, elevation: 8 },
  // Like the web page's popups: the panel colour, a thin line, rounded, a shadow.
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 8,
    backgroundColor: colors.bgPanel, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000000', shadowOpacity: 0.3, shadowRadius: 8, elevation: 8,
  },
  pressed: { backgroundColor: colors.bgHover },
  words: { flex: 1, minWidth: 0 },
  title: { color: colors.textStrong, fontSize: size(14.4), fontWeight: '600' },
  text: { color: colors.text, fontSize: size(14.4) },
});
