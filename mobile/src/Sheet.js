// A menu that slides up from the bottom over a dark backdrop, like the long-press menu on a message:
// the user menu, a group's menu. A tap beside it or Android's back button closes it.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import { useStyles, useTheme } from './theme';

// title: a line on top (the web page's .context-title: whose menu it is), or nothing.
export function Sheet({ title, onClose, children }) {
  const styles = useStyles(makeStyles);
  // A Modal covers the whole screen, navigation bar included: insets.bottom is that bar's height.
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* A Pressable without onPress inside: taps on the sheet itself don't reach the backdrop. */}
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}>
          {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// One choice. danger: in red (Block, Leave).
export function SheetItem({ icon, label, onPress, danger }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
      {icon ? <Icon name={icon} color={danger ? colors.red : colors.icon} /> : null}
      <Text style={[styles.label, danger && styles.danger]}>{label}</Text>
    </Pressable>
  );
}

// A thin line between groups of choices (the web page's <hr> in the menu).
export function SheetLine() {
  const styles = useStyles(makeStyles);
  return <View style={styles.line} />;
}

const makeStyles = (colors, size) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  sheet: { paddingTop: 8, backgroundColor: colors.bgPanel, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  // .context-title: small, muted, bold.
  title: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4, fontSize: size(13.6), fontWeight: '700', color: colors.textMuted },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  pressed: { backgroundColor: colors.bgHover },
  label: { color: colors.text, fontSize: size(16) },
  danger: { color: colors.red },
  line: { height: 1, marginVertical: 4, marginHorizontal: 20, backgroundColor: colors.line },
});
