// A slider (the web page's <input type="range">), which React Native no longer has built in.
//
// PanResponder is React Native's own touch tracking: it reports where a finger goes down, how far it
// has moved since, and when it lets go. The value comes from how far along the track the finger is:
// `min` at the left end, `max` at the right, in steps of `step`. onChange(value) while dragging (to
// show it at once), onDone(value) on letting go (to save it), like the web page's "input" and "change".
import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { useStyles } from './theme';

const THUMB = 20;  // the round handle's size

export default function Slider({ value, min, max, step = 1, onChange, onDone }) {
  const styles = useStyles(makeStyles);
  const [width, setWidth] = useState(0);  // the slider's width, once it has been laid out
  // PanResponder is made once, so its handlers read the newest props from here (see connection.js on refs).
  const latest = useRef({});
  latest.current = { width, min, max, step, value, onChange, onDone };
  const start = useRef(0);  // where the finger went down (from the left edge)

  // A position (from the left edge) as a value: kept between the ends, rounded to a step.
  function valueAt(x) {
    const { width: w, min: lo, max: hi, step: s } = latest.current;
    const fraction = Math.min(1, Math.max(0, (x - THUMB / 2) / Math.max(1, w - THUMB)));
    return Math.round((lo + fraction * (hi - lo)) / s) * s;
  }

  function moveTo(x) {
    const next = valueAt(x);
    if (next !== latest.current.value) latest.current.onChange?.(next);
    latest.current.value = next;  // (the prop catches up on the next drawing)
  }

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Once dragging, it stays ours: the page around it doesn't get to scroll instead.
    onPanResponderTerminationRequest: () => false,
    // locationX: where the finger is in the slider (its parts below don't take touches: pointerEvents).
    onPanResponderGrant: (event) => {
      start.current = event.nativeEvent.locationX;
      moveTo(start.current);
    },
    onPanResponderMove: (event, gesture) => moveTo(start.current + gesture.dx),  // dx: moved since then
    onPanResponderRelease: () => latest.current.onDone?.(latest.current.value),
  })).current;

  const fraction = (value - min) / (max - min);
  return (
    <View style={styles.area} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} {...responder.panHandlers}>
      <View style={styles.track} pointerEvents="none">
        <View style={[styles.filled, { width: `${fraction * 100}%` }]} />
      </View>
      <View style={[styles.thumb, { left: fraction * Math.max(0, width - THUMB) }]} pointerEvents="none" />
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  area: { flex: 1, height: 32, justifyContent: 'center' },  // taller than it looks: easier to hit
  track: { height: 6, marginHorizontal: THUMB / 2, borderRadius: 3, backgroundColor: colors.bgNeutral, overflow: 'hidden' },
  filled: { height: '100%', backgroundColor: colors.accent },
  thumb: {
    position: 'absolute', width: THUMB, height: THUMB, borderRadius: THUMB / 2,
    backgroundColor: '#ffffff', borderWidth: 2, borderColor: colors.accent,
  },
});
