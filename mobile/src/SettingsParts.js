// The pieces every Settings page is made of, with chat.css's #settings look: a page title (h2),
// section headings (h3), labelled text boxes, buttons, a help line and a status line.
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStyles, useTheme } from './theme';

export function Title({ children }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.title}>{children}</Text>;
}

export function Heading({ children }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.heading}>{children}</Text>;
}

export function Help({ children }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.help}>{children}</Text>;
}

// A label over its text box (the web page's <label>Name <input></label>). The rest of the props go
// to the TextInput: value, onChangeText, secureTextEntry, ...
export function Field({ label, style, ...props }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={[styles.input, style]} placeholderTextColor={colors.textMuted} {...props} />
    </View>
  );
}

// #settings button: the accent colour, padding 10px 24px, at the left (not the whole width).
// secondary: grey; small: padding 8px 12px (the picture buttons); style: more of its own (a row's alignment).
export function Button({ label, onPress, secondary, disabled, small, style }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button, small && styles.small, secondary && styles.secondary, disabled && styles.disabled,
        pressed && styles.pressed, style,
      ]}
    >
      <Text style={[styles.buttonText, small && styles.smallText]}>{label}</Text>
    </Pressable>
  );
}

// What happened: {text, error} (red) or {text} (green, it worked), or null. Always takes its line, so
// nothing jumps when it appears.
export function Status({ status }) {
  const styles = useStyles(makeStyles);
  return <Text style={[styles.status, status?.error ? styles.error : styles.success]}>{status?.text ?? ''}</Text>;
}

// A form: its parts 10px apart (#settings form).
export function Form({ children }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.form}>{children}</View>;
}

const makeStyles = (colors, size) => StyleSheet.create({
  // #settings h2: 16px under it, the strong text colour (h2's own size: 1.5em).
  title: { marginBottom: 16, fontSize: size(24), fontWeight: '700', color: colors.textStrong },
  // #settings h3: 20px above, 8px below, 0.75rem, uppercase, muted.
  heading: { marginTop: 20, marginBottom: 8, fontSize: size(12), fontWeight: '700', textTransform: 'uppercase', color: colors.textMuted },
  // .settings-help: 0.8rem, muted.
  help: { fontSize: size(12.8), color: colors.textMuted },
  form: { gap: 10 },
  // #settings label: the words 6px over the box, 0.85rem, soft.
  field: { gap: 6 },
  label: { fontSize: size(13.6), color: colors.textSoft },
  // #settings input: padding 10px 12px, radius 6px, the darkest background, 1rem.
  input: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  button: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 6, backgroundColor: colors.accent },
  small: { paddingVertical: 8, paddingHorizontal: 12 },
  secondary: { backgroundColor: colors.bgNeutral },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(16) },
  smallText: { fontSize: size(14.4) },
  // #settings .status: at least a line tall, 0.9rem; red or green.
  status: { minHeight: size(17), fontSize: size(14.4) },
  error: { color: colors.red },
  success: { color: colors.green },
});
