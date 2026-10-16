// The pinned messages and search popups (the web page's #pins-dialog and #search-dialog): the popup
// itself, and the cards they list messages on (messages.js, makeMessageCard).
import { useEffect } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import MessageText from './MessageText';
import { useStyles, useTheme } from './theme';
import { Avatar } from './people';
import { clock, dayName } from './time';

// Put the cursor in a text box (and so open the keyboard) once a popup has appeared. TextInput's own
// autoFocus inside a Modal comes too early on Android: the box gets the cursor while the popup's
// window isn't ready yet, so no keyboard comes up. 300 ms covers the popup's fade-in.
export function useFocusSoon(ref) {
  useEffect(() => {
    const timer = setTimeout(() => ref.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, []);
}

// A popup in the middle of the screen over a dark backdrop: a title with its icon, × to close, and
// what's in it. Tapping the backdrop or Android's back button closes it too (onRequestClose).
// KeyboardAvoidingView: when the keyboard opens (search), the popup moves up out of its way.
export function Popup({ icon, title, onClose, children }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  // A Modal covers the whole screen, the status and navigation bars included: insets are their
  // heights, so the popup keeps 16px clear of them.
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.backdropOuter, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}
      >
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.popup}>
          <View style={styles.top}>
            {icon ? <Icon name={icon} size={20} color={colors.textStrong} /> : null}
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
              <Icon name="x" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// A message on a card: who and when (and where, if `where` is given, like "#memes"), its text
// formatted like in the chat, its file's name, and the buttons (`children`, CardButtons).
// onUserMenu(id): a long press on the sender (the web page's right-click on the card's head).
export function MessageCard({ message, where, connection, onUserMenu, children }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { users, emoji } = connection;
  const sent = new Date(message.sent_at);
  const file = message.file;
  return (
    <View style={styles.card}>
      <Pressable
        style={styles.head}
        disabled={!onUserMenu || !users[message.user_id]}
        onLongPress={() => onUserMenu(message.user_id)}
      >
        <Avatar user={users[message.user_id]} name={message.name} size={24} />
        <Text style={styles.name} numberOfLines={1}>{users[message.user_id]?.name ?? message.name}</Text>
        {/* "#memes · Yesterday at 14:03" */}
        <Text style={styles.time} numberOfLines={1}>{(where ? where + ' · ' : '') + dayName(sent) + ' at ' + clock(sent)}</Text>
      </Pressable>
      {message.text ? <MessageText text={message.text} users={users} emoji={emoji} edited={message.edited_at} /> : null}
      {file ? (
        <View style={styles.file}>
          <Icon name={file.image ? 'image' : file.video ? 'video' : 'paperclip'} size={16} color={colors.textSoft} />
          <Text style={styles.fileName} numberOfLines={1}>{file.filename}</Text>
        </View>
      ) : null}
      <View style={styles.buttons}>{children}</View>
    </View>
  );
}

// The popups' own buttons at the bottom right (the web page's .group-dialog-buttons): Cancel and
// Create group, Close and New link. `secondary`: grey; `danger`: red (Ban); `disabled`: faded and not pressable.
export function DialogButtons({ children }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.dialogButtons}>{children}</View>;
}

export function DialogButton({ label, onPress, secondary, danger, disabled }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.dialogButton, secondary && styles.secondary, danger && styles.danger, disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.dialogButtonText}>{label}</Text>
    </Pressable>
  );
}

// A small button for a card. `secondary`: grey instead of the accent colour.
export function CardButton({ label, onPress, secondary }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

// chat.css's sizes, rem as 16 px.
export const makeStyles = (colors, size) => StyleSheet.create({
  // The backdrop: rgba(0, 0, 0, 0.6), the popup in the middle.
  backdropOuter: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  // Taps beside the popup. (Its edges spelled out: StyleSheet.absoluteFill did nothing in RN 0.86, see Drawer.js.)
  backdropTap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // #pins-dialog: min(520px, 100% - 32px) wide, padding 16px 20px 20px, radius 8px.
  popup: {
    alignSelf: 'center', width: '100%', maxWidth: 520, maxHeight: '100%', paddingHorizontal: 20, paddingTop: 16,
    paddingBottom: 20, borderRadius: 8, backgroundColor: colors.bgPanel,
  },
  // .pins-top: the title (1.1rem, bold) on the left, × on the right, 12px above the rest.
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  title: { flex: 1, fontSize: size(17.6), fontWeight: '700', color: colors.textStrong },
  // .card-list: 8px between the cards.
  list: { flexShrink: 1 },
  listInside: { gap: 8 },
  // .pins-empty: 0.9rem, muted.
  empty: { fontSize: size(14.4), color: colors.textMuted },
  // .message-card: padding 10px 12px, radius 8px, the darkest background.
  card: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.bgDarkest },
  // .card-head: 8px apart, 4px above the text; the time 0.75rem and muted.
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  name: { flexShrink: 1, fontWeight: '700', color: colors.text, fontSize: size(16) },
  time: { flexShrink: 1, fontSize: size(12), color: colors.textMuted },
  // .card-file: 0.85rem, soft.
  file: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fileName: { flexShrink: 1, fontSize: size(13.6), color: colors.textSoft },
  // .card-buttons: at the right, 6px apart, 8px below; each padding 4px 12px, radius 6px, 0.85rem.
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginTop: 8 },
  button: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.bgNeutral },
  danger: { backgroundColor: colors.buttonRed },  // .group-dialog-buttons button.danger
  pressed: { opacity: 0.8 },
  buttonText: { fontSize: size(13.6), color: '#ffffff' },
  // .group-dialog-buttons: at the right, 8px apart; each padding 10px 20px, radius 6px, 1rem.
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  dialogButton: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 6, backgroundColor: colors.accent },
  disabled: { opacity: 0.5 },
  dialogButtonText: { fontSize: size(16), color: '#ffffff' },
  // .group-dialog-help: 0.85rem, muted.
  help: { fontSize: size(13.6), color: colors.textMuted },
  // Text boxes in the popups (#group-filter): padding 8px 10px, radius 6px, the darkest background.
  input: {
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(15.2),
  },
  // .action-status: red; .success: green.
  problem: { fontSize: size(13.6), color: colors.red },
  success: { fontSize: size(13.6), color: colors.green },
});
