// A panel that slides in from the left or right side over the chat, with a dark backdrop behind it
// (tap it to close): the web page's phone drawers (#sidebar and #members, chat.css under 700px):
// 80% of the width, at most 280px, sliding for 0.2 s with the "ease" curve.
//
// Animated: React Native's way to move things smoothly. An Animated.Value goes from 0 (open) to 1
// (closed) over 200 ms, and the panel's position and the backdrop's darkness are worked out from
// it each frame (interpolate). useNativeDriver: the phone animates it itself, so it stays smooth
// even while our JavaScript is busy.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useStyles } from './theme';

export default function Drawer({ open, side, onClose, children }) {
  const styles = useStyles(makeStyles);
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.8, 280);
  const closed = useRef(new Animated.Value(open ? 0 : 1)).current;
  const [shown, setShown] = useState(open);  // still drawn while sliding out

  // Opening: first draw it (shown), and only then, once its views exist (the effect below runs
  // after that redraw), slide it in. Started before, the backdrop's fade was lost.
  useEffect(() => {
    if (open) setShown(true);
  }, [open]);

  useEffect(() => {
    if (!shown) return;
    Animated.timing(closed, {
      toValue: open ? 0 : 1,
      duration: 200,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),  // CSS's "ease"
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !open) setShown(false);
    });
  }, [open, shown]);

  if (!shown) return null;
  const offscreen = side === 'left' ? -drawerWidth : drawerWidth;
  return (
    <>
      <Animated.View style={[styles.backdrop, { opacity: closed.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
        <Pressable style={styles.fill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.drawer,
          side === 'left' ? { left: 0 } : { right: 0 },
          { width: drawerWidth, transform: [{ translateX: closed.interpolate({ inputRange: [0, 1], outputRange: [0, offscreen] }) }] },
        ]}
      >
        {children}
      </Animated.View>
    </>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // Over everything: pinned to all four edges.
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  fill: { flex: 1 },
  drawer: { position: 'absolute', top: 0, bottom: 0, backgroundColor: colors.bgPanel },
});
