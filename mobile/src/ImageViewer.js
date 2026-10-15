// A picture opened full screen (the web page's #viewer popup), with the phone's own way of looking
// closer: pinch to zoom, drag a zoomed picture around, double tap to zoom in or back out.
// × or the back button closes it; download saves the picture in the phone's Download folder, share sends it on.
//
// Fingers are read by react-native-gesture-handler and the picture is moved by react-native-reanimated.
// Their code runs on the UI thread (the one drawing the screen) rather than in JavaScript's own,
// so the picture follows the fingers smoothly even while the chat is busy. Values the two share
// are "shared values" (useSharedValue); functions that run there are marked 'worklet'.
import { useState } from 'react';
import {
  ActivityIndicator, Alert, Image, Modal, Pressable, StyleSheet, Text, ToastAndroid, View, useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import { colors } from './colors';
import { SERVER } from './config';
import { downloadFile, saveFile, shareFile } from './files';

const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;

// A number kept between low and high.
function clamp(value, low, high) {
  'worklet';
  return Math.min(Math.max(value, low), high);
}

// file: the attachment ({id, filename, size}). onClose: closes the viewer.
export default function ImageViewer({ file, onClose }) {
  // The area the picture has: the whole screen, measured once the viewer is laid out (onLayout).
  const [screen, setScreen] = useState(useWindowDimensions());
  const insets = useSafeAreaInsets();
  const [natural, setNatural] = useState(null);  // the picture's own size, once loaded
  const [busy, setBusy] = useState(null);  // "save" or "share" while that's downloading

  // The picture's size on screen at zoom 1: as big as fits, keeping its shape ("contain").
  let shown = { width: screen.width, height: screen.height };
  if (natural) {
    const fit = Math.min(screen.width / natural.width, screen.height / natural.height);
    shown = { width: natural.width * fit, height: natural.height * fit };
  }

  // How the picture is moved: zoomed by `scale` around the screen's middle, then shifted by x, y.
  // The "start" ones remember where a gesture began.
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startFocus = useSharedValue({ x: 0, y: 0 });

  // How far the picture may be shifted at a zoom: until its edge reaches the screen's edge
  // (and not at all along a side where the zoomed picture still fits on the screen).
  const shownWidth = shown.width;
  const shownHeight = shown.height;
  const screenWidth = screen.width;
  const screenHeight = screen.height;
  function limitX(zoom) {
    'worklet';
    return Math.max(0, (shownWidth * zoom - screenWidth) / 2);
  }
  function limitY(zoom) {
    'worklet';
    return Math.max(0, (shownHeight * zoom - screenHeight) / 2);
  }

  // After a gesture: back inside the limits, smoothly (zoomed out past 1 = back to 1).
  function settle() {
    'worklet';
    const zoom = clamp(scale.value, 1, MAX_ZOOM);
    scale.value = withTiming(zoom);
    x.value = withTiming(clamp(x.value, -limitX(zoom), limitX(zoom)));
    y.value = withTiming(clamp(y.value, -limitY(zoom), limitY(zoom)));
  }

  // Two fingers: zoom around the point between them (the focus), so what's under your fingers
  // stays under them. Positions are measured from the screen's middle, where the zoom is centred.
  const pinch = Gesture.Pinch()
    .onStart((event) => {
      startScale.value = scale.value;
      startX.value = x.value;
      startY.value = y.value;
      startFocus.value = { x: event.focalX - screenWidth / 2, y: event.focalY - screenHeight / 2 };
    })
    .onUpdate((event) => {
      // Fingers never lift at exactly the same moment: with one left, Android's last update has the
      // "point between the fingers" on that finger (and the scale measured with it), and the picture
      // jumped there. So only two-finger updates count.
      if (event.numberOfPointers < 2) return;
      // Down to half size while pinching (it springs back to 1 after), up to MAX_ZOOM.
      const zoom = clamp(startScale.value * event.scale, 0.5, MAX_ZOOM);
      const growth = zoom / startScale.value;
      const focusX = event.focalX - screenWidth / 2;
      const focusY = event.focalY - screenHeight / 2;
      // The point that was under the fingers at the start, grown by `growth`, moved to where
      // the fingers are now.
      x.value = focusX - (startFocus.value.x - startX.value) * growth;
      y.value = focusY - (startFocus.value.y - startY.value) * growth;
      scale.value = zoom;
    })
    .onEnd(settle);

  // One finger on a zoomed picture: drag it around. (Only one: with two, the pinch moves it,
  // through the point between the fingers; both writing x and y made it jump.)
  const pan = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      if (scale.value <= 1) return;  // nothing to look around at
      x.value = startX.value + event.translationX;
      y.value = startY.value + event.translationY;
    })
    .onEnd(settle);

  // Double tap: zoomed in → back to the whole picture; else zoom in on the tapped spot.
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDistance(10)  // a finger that moves more than 10 px isn't tapping: give up at once
    .onEnd((event) => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
        return;
      }
      const tapX = event.x - screenWidth / 2;
      const tapY = event.y - screenHeight / 2;
      scale.value = withTiming(DOUBLE_TAP_ZOOM);
      x.value = withTiming(clamp(-tapX * (DOUBLE_TAP_ZOOM - 1), -limitX(DOUBLE_TAP_ZOOM), limitX(DOUBLE_TAP_ZOOM)));
      y.value = withTiming(clamp(-tapY * (DOUBLE_TAP_ZOOM - 1), -limitY(DOUBLE_TAP_ZOOM), limitY(DOUBLE_TAP_ZOOM)));
    });

  // Race: whichever starts first wins and the other is cancelled, without waiting. A pinch starts as
  // soon as the fingers spread, a double tap only at its second tap. (Exclusive, tried first, made
  // the pinch wait until the double tap gave up, which it only did after half a second.)
  // Pinch and pan are Simultaneous: one finger can drag, then a second join in to pinch.
  const gestures = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  // Turns the shared values into the picture's transform, on the UI thread, every frame.
  const pictureStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  // Both first download the picture into the app's own storage (files.js), then hand it on.
  async function save() {
    if (busy) return;
    setBusy('save');
    try {
      const saved = await saveFile(file, await downloadFile(file));
      // A toast: Android's own little notice at the bottom, gone by itself after a moment.
      ToastAndroid.show(`Saved to Download as ${saved.name}`, ToastAndroid.SHORT);
    } catch (error) {
      Alert.alert("Couldn't save the picture", error.message);
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    if (busy) return;
    setBusy('share');
    try {
      await shareFile(await downloadFile(file));
    } catch (error) {
      Alert.alert(error.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    // statusBarTranslucent / navigationBarTranslucent: the black reaches behind the phone's bars.
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      {/* A Modal is a separate window on Android, so gestures need their own root inside it. */}
      <GestureHandlerRootView style={styles.backdrop}>
        <GestureDetector gesture={gestures}>
          <View
            style={styles.stage}
            onLayout={(event) => setScreen({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
          >
            <Animated.View style={[shown, pictureStyle]}>
              <Image
                source={{ uri: `${SERVER}/uploads/${encodeURIComponent(file.id)}` }}
                style={styles.picture}
                resizeMode="contain"
                onLoad={(event) => setNatural({ width: event.nativeEvent.source.width, height: event.nativeEvent.source.height })}
              />
            </Animated.View>
            {natural ? null : <ActivityIndicator style={styles.loading} color="#ffffff" size="large" />}
          </View>
        </GestureDetector>

        {/* The bar on top: the file's name, download, share, close. Over the picture, below the status bar. */}
        <View style={[styles.bar, { paddingTop: insets.top + 4 }]}>
          <Text numberOfLines={1} style={styles.name}>{file.filename}</Text>
          <Pressable onPress={save} hitSlop={8} style={styles.button}>
            {busy === 'save' ? <ActivityIndicator color="#ffffff" /> : <Icon name="download" size={22} color="#ffffff" />}
          </Pressable>
          <Pressable onPress={share} hitSlop={8} style={styles.button}>
            {busy === 'share' ? <ActivityIndicator color="#ffffff" /> : <Icon name="share-2" size={22} color="#ffffff" />}
          </Pressable>
          <Pressable onPress={onClose} hitSlop={8} style={styles.button}>
            <Icon name="x" size={24} color="#ffffff" />
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // The web page's #viewer: almost black behind the picture.
  backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.92)' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  picture: { width: '100%', height: '100%' },
  loading: { position: 'absolute' },
  bar: {
    position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingBottom: 4, backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  name: { flex: 1, color: '#ffffff', fontSize: 15, paddingHorizontal: 8 },
  button: { padding: 10 },
});
