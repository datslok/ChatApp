// Settings → Appearance (the web page's settings.js, "Appearance"): the theme, colours picked on top of
// it, and the text size. Kept with the account, so the web page and the Windows app change too.
//
// Like the web page: a change shows at once (setAppearance: everything that reads the theme draws
// again), then it's saved (POST /settings/appearance), and the server sends it to our other devices.
// While a colour or the text size is being dragged, only the screen follows; it's saved on letting go.
// The fonts are the web page's, as near as Android has them (theme.js, FONT_FAMILIES). (Its Scale is
// the Windows app's own zoom, so that isn't here.)
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ColorPicker, { HueSlider, Panel1, Preview } from 'reanimated-color-picker';
import { DialogButton, DialogButtons, Popup } from './MessageCard';
import Slider from './Slider';
import { Button, Heading, Help, Status, Title } from './SettingsParts';
import { Choices } from './VoiceSettings';
import { postJson } from './api';
import {
  FONT_CHOICES, FONT_FAMILIES, PICKABLE_COLOURS, THEME_CHOICES, makeTheme, useStyles, useTheme,
} from './theme';

// One theme's swatch: a circle, its top left half the theme's panel colour and the rest its
// background (the web page's diagonal gradient), with a ring around the chosen one.
function Swatch({ theme, label, chosen, onPress }) {
  const styles = useStyles(makeStyles);
  const { colors } = makeTheme({ theme });
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} style={[styles.swatchRing, chosen && styles.swatchChosen]}>
      <View style={[styles.swatch, { backgroundColor: colors.bgMain, borderColor: colors.line }]}>
        {/* A square turned 45° around the top left corner covers exactly the top left half. */}
        <View style={[styles.swatchHalf, { backgroundColor: colors.bgPanel }]} />
      </View>
    </Pressable>
  );
}

// Picking one colour: the picker (a square for how light and how strong, a slider for which colour),
// the old and new side by side, Cancel and Done. onPreview(hex) while dragging; onDone(hex).
// (Settings → Admin → Roles uses it too, for a role's colour.)
export function ColourDialog({ label, value, onPreview, onDone, onCancel }) {
  const styles = useStyles(makeStyles);
  // The colour it opened with: `value` follows the preview while dragging, but the picker's "before"
  // half (and where it starts) should stay this one.
  const initial = useRef(value).current;
  const chosen = useRef(value);
  const lastPreview = useRef(0);
  // Every move redraws the whole app in the new colour, so at most 12 times a second (every 80 ms).
  function preview(colour) {
    chosen.current = colour.hex.slice(0, 7);  // "#rrggbb" (without an opacity on the end)
    const now = Date.now();
    if (now - lastPreview.current > 80) {
      lastPreview.current = now;
      onPreview(chosen.current);
    }
  }
  return (
    <Popup title={label} onClose={onCancel}>
      {/* The picker's handles are dragged with react-native-gesture-handler, which needs its root
          view inside each popup (a Modal is a window of its own, like ImageViewer's). */}
      <GestureHandlerRootView style={styles.pickerRoot}>
        <ColorPicker
          value={initial}
          onChangeJS={preview}
          onCompleteJS={(colour) => {
            preview(colour);
            onPreview(chosen.current);  // (the last move, even if it came within the 80 ms)
          }}
          style={styles.picker}
        >
          <Preview hideInitialColor={false} />
          <Panel1 style={styles.panel} />
          <HueSlider />
        </ColorPicker>
      </GestureHandlerRootView>
      <DialogButtons>
        <DialogButton label="Cancel" secondary onPress={onCancel} />
        <DialogButton label="Done" onPress={() => onDone(chosen.current)} />
      </DialogButtons>
    </Popup>
  );
}

export default function AppearanceSettings() {
  const styles = useStyles(makeStyles);
  const { appearance, colors, setAppearance } = useTheme();
  const [status, setStatus] = useState(null);  // only when saving failed
  const [picking, setPicking] = useState(null);  // the colour being picked: {name, label, before}
  const [fontSize, setFontSize] = useState(appearance.font_size);  // the slider's number while dragging
  // Changed on another device meanwhile: the slider follows.
  useEffect(() => setFontSize(appearance.font_size), [appearance.font_size]);

  // Show and save. (The server checks every value, and sends them to our other devices.)
  async function save(next) {
    setAppearance(next);
    const result = await postJson('/settings/appearance', next);
    setStatus(result.ok ? null : { text: "Couldn't save that. Is the connection lost?", error: true });
  }

  // The colour shown in a row: picked by hand, or the theme's own ("bg-main" -> colors.bgMain).
  const colourOf = (name) => appearance.colours[name] ?? colors[name.replace(/-(\w)/g, (w, l) => l.toUpperCase())];
  const withColour = (name, hex) => ({ ...appearance, colours: { ...appearance.colours, [name]: hex } });

  return (
    <View>
      <Title>Appearance</Title>

      <Heading>Theme</Heading>
      <View style={styles.swatches}>
        {THEME_CHOICES.map(([theme, label]) => (
          // A theme starts from its own colours: picked ones would clash (dark text on a dark background).
          <Swatch
            key={theme} theme={theme} label={label} chosen={appearance.theme === theme}
            onPress={() => save({ ...appearance, theme, colours: {} })}
          />
        ))}
      </View>

      <Heading>Colours</Heading>
      <Help>Change any of these on top of the theme. Picking a theme starts again from its own colours.</Help>
      <View style={styles.colours}>
        {PICKABLE_COLOURS.map(([name, label]) => (
          <Pressable key={name} onPress={() => setPicking({ name, label, before: appearance })} style={styles.colourRow}>
            <Text style={styles.colourLabel}>{label}</Text>
            <View style={[styles.colourBox, { backgroundColor: colourOf(name) }]} />
          </Pressable>
        ))}
      </View>
      <Button label="Reset colours" secondary small onPress={() => save({ ...appearance, colours: {} })} />

      <Heading>Font</Heading>
      {/* Each name in its own font, like the web page's choices. (System's spelled out as sans-serif:
          left empty, it would take the chosen font from the button around it.) */}
      <Choices
        choices={FONT_CHOICES.map(([font, label]) => [
          font, <Text style={{ fontFamily: FONT_FAMILIES[font] ?? 'sans-serif' }}>{label}</Text>,
        ])}
        value={appearance.font}
        onPick={(font) => save({ ...appearance, font })}
      />
      <Help>Calibri is a Windows font: on a phone it looks like System.</Help>

      <Heading>Text size</Heading>
      {/* #settings label.slider-row: the words, the slider, the number. */}
      <View style={styles.sliderRow}>
        <Text style={styles.sliderLabel}>Text size</Text>
        <Slider
          value={fontSize} min={12} max={20} step={1}
          onChange={(value) => {
            setFontSize(value);
            setAppearance({ ...appearance, font_size: value });  // everything follows while dragging
          }}
          onDone={(value) => save({ ...appearance, font_size: value })}
        />
        <Text style={styles.sliderValue}>{fontSize}px</Text>
      </View>
      <Status status={status} />

      {picking ? (
        <ColourDialog
          label={picking.label}
          value={colourOf(picking.name)}
          onPreview={(hex) => setAppearance(withColour(picking.name, hex))}
          onDone={(hex) => {
            setPicking(null);
            save(withColour(picking.name, hex));
          }}
          onCancel={() => {
            setAppearance(picking.before);  // back to how it was before picking
            setPicking(null);
          }}
        />
      ) : null}
    </View>
  );
}

const SWATCH = 48;

const makeStyles = (colors, size) => StyleSheet.create({
  // .theme-swatches: 12px apart, wrapping.
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  // The chosen one: a 3px ring in the text colour, 2px away from it.
  swatchRing: { padding: 2, borderRadius: SWATCH, borderWidth: 3, borderColor: 'transparent' },
  swatchChosen: { borderColor: colors.text },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, borderWidth: 2, overflow: 'hidden' },
  swatchHalf: {
    position: 'absolute', width: SWATCH * Math.SQRT2, height: SWATCH * Math.SQRT2,
    left: -SWATCH * Math.SQRT2 / 2, top: -SWATCH * Math.SQRT2 / 2, transform: [{ rotate: '45deg' }],
  },
  // .colour-pickers: rows 8px apart, at most 280px wide; each the label and its colour.
  colours: { gap: 8, maxWidth: 280, marginTop: 10, marginBottom: 12 },
  colourRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  colourLabel: { fontSize: size(15.2), color: colors.text },
  colourBox: { width: 48, height: 32, borderRadius: 4, borderWidth: 1, borderColor: colors.line },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sliderLabel: { width: 90, fontSize: size(13.6), color: colors.textSoft },
  sliderValue: { width: 44, fontSize: size(13.6), color: colors.textSoft, textAlign: 'right' },
  pickerRoot: { flexGrow: 0 },
  picker: { gap: 16, marginBottom: 6 },
  panel: { height: 200, borderRadius: 8 },
});
