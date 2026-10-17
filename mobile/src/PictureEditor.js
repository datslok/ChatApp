// The picture editor (the web page's #cropper, settings.js "Picture editor"): move and zoom a new
// profile picture, banner or custom emoji inside a frame before it's uploaded. One finger drags it,
// two pinch to zoom (around the point between them), and the slider zooms too, like the web page's.
//
// The picture's place is three numbers, as on the web page: `zoom` (1 = the whole picture just fits
// inside the frame, up to MAX_ZOOM) and x, y (where its top left corner is, in the frame). The frame's
// empty part is saved see-through. They're shared values
// (react-native-reanimated), so the gestures move the picture on the UI thread without waiting for
// JavaScript (see ImageViewer.js). Save turns them back into a rectangle of the picture's own pixels:
//   - a still picture is cut out and shrunk here (expo-image-manipulator) and saved as WebP; if the
//     rectangle reaches past its edges, the part that overlaps is sent with a rectangle in the address
//     and the server adds the see-through space (Android's manipulator can't: its extent is web-only);
//   - an animated GIF is sent whole with that rectangle in the address, and the server cuts it out of
//     every frame (server.py, make_animated_webp), so it keeps moving. The same as the web page.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import Slider from './Slider';
import { useStyles } from './theme';

// Each kind's frame (its shape, at most this big on screen) and the size it's saved at: the web page's
// CROP_SHAPES. Banners are saved bigger than their frame, as they're shown wide.
const SHAPES = {
  avatar: { title: 'Edit picture', width: 256, height: 256, round: true, saveWidth: 256, saveHeight: 256 },
  banner: { title: 'Edit banner', width: 300, height: 100, round: false, saveWidth: 960, saveHeight: 320 },
  emoji: { title: 'Edit emoji', width: 160, height: 160, round: false, saveWidth: 128, saveHeight: 128 },
};
const MAX_ZOOM = 4;
const MAX_GIF_SIZE = 10 * 1024 * 1024;  // as the server's: GIFs come whole, so they may be bigger
const DISPLAY_SIZE = 2048;  // the longest side of the copy shown while editing (see pickPicture)

function clamp(value, low, high) {
  'worklet';
  return Math.min(Math.max(value, low), high);
}

// Where the picture may be along one side (the web page's clampSide): bigger than the frame, its edges
// never inside the frame's; smaller, centred.
function clampSide(position, frame, picture) {
  'worklet';
  if (picture <= frame) return (frame - picture) / 2;
  return clamp(position, frame - picture, 0);
}

// Choose a picture with Android's photo picker and get it ready for the editor. Returns null if
// nothing was chosen, else {uri, width, height, gif, image}; throws an Error with words to show.
//
// quality 1 makes the picker hand over the file exactly as it is (expo-image-picker copies it), so a
// GIF stays a GIF. A photo may be stored sideways with a note saying which way is up (EXIF): the
// manipulator turns it the right way while loading it (`image`, full size, which Save cuts from), and
// the editor shows a smaller copy of that (DISPLAY_SIZE), so what you see and what's cut always agree.
export async function pickPicture() {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset.mimeType === 'image/gif') {
    if ((asset.fileSize ?? 0) > MAX_GIF_SIZE) throw new Error('GIFs can be at most 10 MB.');
    return { uri: asset.uri, width: asset.width, height: asset.height, gif: true };
  }
  try {
    const image = await ImageManipulator.manipulate(asset.uri).renderAsync();
    const fit = Math.min(1, DISPLAY_SIZE / Math.max(image.width, image.height));
    const shown = await ImageManipulator.manipulate(image)
      .resize({ width: Math.round(image.width * fit), height: Math.round(image.height * fit) })
      .renderAsync();
    // PNG keeps see-through parts (an emoji's); JPEG is quicker for photos.
    const see = asset.mimeType === 'image/png' || asset.mimeType === 'image/webp';
    const copy = await shown.saveAsync({ format: see ? SaveFormat.PNG : SaveFormat.JPEG, compress: 0.9 });
    return { uri: copy.uri, width: image.width, height: image.height, gif: false, image };
  } catch {
    throw new Error("Couldn't read that picture. Try a PNG or JPEG.");
  }
}

// picture: from pickPicture. kind: "avatar", "banner" or "emoji". onDone({uri, type, params}) with the
// finished file to upload (params: a GIF's rectangle, for the address); onCancel closes it.
export default function PictureEditor({ picture, kind, onDone, onCancel }) {
  const styles = useStyles(makeStyles);
  const shape = SHAPES[kind];
  const window = useWindowDimensions();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState(null);

  // The frame on screen: the shape's size, smaller if the popup is narrower (#cropper: 340 px at most,
  // 16 px from the screen's sides, 24 px padding inside).
  const room = Math.min(340, window.width - 32) - 48;
  const frameWidth = Math.min(shape.width, room);
  const frameHeight = frameWidth * shape.height / shape.width;
  // The picture's size in the frame at zoom 1: the whole picture just fits, its width and its height.
  const minScale = Math.min(frameWidth / picture.width, frameHeight / picture.height);
  const baseWidth = picture.width * minScale;
  const baseHeight = picture.height * minScale;

  // Start at zoom 1, centred.
  const zoom = useSharedValue(1);
  const x = useSharedValue((frameWidth - baseWidth) / 2);
  const y = useSharedValue((frameHeight - baseHeight) / 2);
  const start = useSharedValue({ zoom: 1, x: 0, y: 0, focusX: 0, focusY: 0 });
  const [zoomShown, setZoomShown] = useState(1);  // the slider's position (JavaScript's copy of zoom)

  // Keep the picture in its allowed place (the web page's clampCrop).
  function place(nextX, nextY, nextZoom) {
    'worklet';
    zoom.value = nextZoom;
    x.value = clampSide(nextX, frameWidth, baseWidth * nextZoom);
    y.value = clampSide(nextY, frameHeight, baseHeight * nextZoom);
  }

  // One finger: drag. (Only one: with two, the pinch moves it, through the point between them.)
  const pan = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      start.value = { ...start.value, x: x.value, y: y.value };
    })
    .onUpdate((event) => {
      place(start.value.x + event.translationX, start.value.y + event.translationY, zoom.value);
    });

  // Two fingers: zoom around the point between them, so what's under your fingers stays there. The
  // point of the picture that was under them at the start (in zoom-1 frame pixels) is put back under
  // where they are now, at the new zoom.
  const pinch = Gesture.Pinch()
    .onStart((event) => {
      start.value = { zoom: zoom.value, x: x.value, y: y.value, focusX: event.focalX, focusY: event.focalY };
    })
    .onUpdate((event) => {
      if (event.numberOfPointers < 2) return;  // (the last update as a finger lifts: see ImageViewer.js)
      const s = start.value;
      const next = clamp(s.zoom * event.scale, 1, MAX_ZOOM);
      const pointX = (s.focusX - s.x) / s.zoom;
      const pointY = (s.focusY - s.y) / s.zoom;
      place(event.focalX - pointX * next, event.focalY - pointY * next, next);
      scheduleOnRN(setZoomShown, next);  // the slider follows
    });

  const gestures = Gesture.Simultaneous(pan, pinch);

  // The slider: zoom around the frame's middle (the web page's setZoom).
  function zoomTo(next) {
    const middleX = (frameWidth / 2 - x.value) / zoom.value;
    const middleY = (frameHeight / 2 - y.value) / zoom.value;
    place(frameWidth / 2 - middleX * next, frameHeight / 2 - middleY * next, next);
    setZoomShown(next);
  }

  // A transform scales around the view's middle, so the shift that puts its top left corner at x, y
  // is x plus half of what the zoom added.
  const pictureStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value + baseWidth * (zoom.value - 1) / 2 },
      { translateY: y.value + baseHeight * (zoom.value - 1) / 2 },
      { scale: zoom.value },
    ],
  }));

  async function save() {
    // Which part of the picture is in the frame, in its own pixels: frame pixels / the scale.
    // It may reach past the picture's edges (negative left/top, or wider than what's left).
    const scale = minScale * zoom.value;
    const left = -x.value / scale;
    const top = -y.value / scale;
    const width = frameWidth / scale;
    const height = frameHeight / scale;
    if (picture.gif) {
      // The server cuts it from every frame, filling in see-through pixels past the edges.
      const box = { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
      onDone({ uri: picture.uri, type: 'image/gif', params: box });
      return;
    }
    setSaving(true);
    try {
      // The part of the rectangle that overlaps the picture, in whole picture pixels.
      const fromX = Math.max(0, Math.floor(left));
      const fromY = Math.max(0, Math.floor(top));
      const toX = Math.min(picture.width, Math.ceil(left + width));
      const toY = Math.min(picture.height, Math.ceil(top + height));
      // Does the picture fill the frame (give or take a pixel)? Then it's simply shrunk to the saved
      // size. Else the part is shrunk by the same amount (save pixels per picture pixel), and the server
      // puts it into a see-through rectangle of the saved size that starts left of and above the part
      // by the empty space's width and height.
      const fills = toX - fromX >= width - 1 && toY - fromY >= height - 1;
      const save = shape.saveWidth / width;
      const cut = await ImageManipulator.manipulate(picture.image)
        .crop({ originX: fromX, originY: fromY, width: toX - fromX, height: toY - fromY })
        .resize(fills
          ? { width: shape.saveWidth, height: shape.saveHeight }
          : { width: Math.max(1, Math.round((toX - fromX) * save)), height: Math.max(1, Math.round((toY - fromY) * save)) })
        .renderAsync();
      const params = fills ? {} : {
        left: -Math.round((fromX - left) * save),
        top: -Math.round((fromY - top) * save),
        width: shape.saveWidth,
        height: shape.saveHeight,
      };
      const file = await cut.saveAsync({ format: fills ? SaveFormat.WEBP : SaveFormat.PNG, compress: 0.85 });
      onDone({ uri: file.uri, type: fills ? 'image/webp' : 'image/png', params });
    } catch {
      setSaving(false);
      setProblem("Couldn't save that picture.");
    }
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onCancel} navigationBarTranslucent statusBarTranslucent>
      {/* A Modal is a window of its own: the gestures need their own root inside it. */}
      <GestureHandlerRootView style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.title}>{shape.title}</Text>
          <Text style={styles.hint}>Drag to move. Pinch or use the slider to zoom.</Text>
          <GestureDetector gesture={gestures}>
            <View
              style={[
                styles.frame,
                { width: frameWidth, height: frameHeight },
                shape.round && { borderRadius: frameWidth / 2 },
              ]}
            >
              <Animated.View style={[{ width: baseWidth, height: baseHeight }, styles.picture, pictureStyle]}>
                {/* (A GIF moves by itself: React Native's Image plays it.) */}
                <Image source={{ uri: picture.uri }} style={styles.fill} />
              </Animated.View>
            </View>
          </GestureDetector>
          <View style={styles.zoomRow}>
            <Text style={styles.zoomLabel}>Zoom</Text>
            <Slider value={zoomShown} min={1} max={MAX_ZOOM} step={0.01} onChange={zoomTo} />
          </View>
          {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          <View style={styles.buttons}>
            <Pressable onPress={onCancel} style={({ pressed }) => [styles.button, styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={save} disabled={saving}
              style={({ pressed }) => [styles.button, (pressed || saving) && styles.pressed]}
            >
              <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// chat.css's #cropper.
const makeStyles = (colors, size) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.7)' },
  // width min(340px, 100% - 32px), padding 24px, radius 8px, everything centred.
  dialog: {
    width: '100%', maxWidth: 340, marginHorizontal: 16, padding: 24, borderRadius: 8,
    backgroundColor: colors.bgPanel, alignItems: 'center',
  },
  title: { marginBottom: 4, fontSize: size(24), fontWeight: '700', color: colors.textStrong },
  hint: { marginBottom: 16, fontSize: size(13.6), color: colors.textMuted, textAlign: 'center' },
  // #crop-frame: radius 8px (a circle for pictures), the darkest background, cutting off what sticks out.
  frame: { overflow: 'hidden', borderRadius: 8, backgroundColor: colors.bgDarkest },
  picture: { position: 'absolute', left: 0, top: 0 },
  fill: { width: '100%', height: '100%' },
  // .crop-zoom: 16px above, 12px apart, 0.85rem, soft.
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, alignSelf: 'stretch' },
  zoomLabel: { fontSize: size(13.6), color: colors.textSoft },
  problem: { marginTop: 10, fontSize: size(13.6), color: colors.red },
  // .crop-buttons: two equally wide buttons, 8px apart, 20px above.
  buttons: { flexDirection: 'row', gap: 8, marginTop: 20, alignSelf: 'stretch' },
  button: { flex: 1, padding: 10, borderRadius: 6, backgroundColor: colors.accent, alignItems: 'center' },
  cancel: { backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(16) },
});
