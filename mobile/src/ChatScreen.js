// One chat: its messages live, and writing (sending, replies, reactions, editing, deleting).
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, BackHandler, FlatList, KeyboardAvoidingView, Modal, Pressable, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from './colors';
import { chatTitle } from './ChannelsScreen';

// The reactions in the long-press menu (a full emoji picker comes later).
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

// Messages store mentions and custom emoji by id ("<@3>", "<@everyone>", "<:17>"), so renames
// show the new name. Turn them back into words: "@kari", ":pog:" (the pictures come later).
// (The server turns them into ids again when an edited text comes back.)
function readableText(text, users, emoji) {
  return text
    .replace(/<@(\d+)>/g, (whole, id) => '@' + (users[id]?.name ?? 'someone'))
    .replace(/<@everyone>/g, '@everyone')
    .replace(/<:(\d+)>/g, (whole, id) => (emoji[id] ? `:${emoji[id]}:` : ':?:'));
}

// A reaction is an emoji, or a custom emoji as "custom:17": shown by name until we draw pictures.
function reactionLabel(reaction, emoji) {
  const custom = reaction.match(/^custom:(\d+)$/);
  return custom ? `:${emoji[custom[1]] ?? '?'}:` : reaction;
}

// "14:05" for today, "12.10 14:05" for an older message.
function when(isoTime) {
  const time = new Date(isoTime);
  const two = (n) => String(n).padStart(2, '0');
  const clock = `${two(time.getHours())}:${two(time.getMinutes())}`;
  if (time.toDateString() === new Date().toDateString()) return clock;
  return `${time.getDate()}.${time.getMonth() + 1} ${clock}`;
}

function Message({ message, users, emoji, myId, onLongPress, onReact }) {
  const name = (message.user_id && users[message.user_id]?.name) || message.name;
  const text = readableText(message.text, users, emoji);
  const note = message.kind !== null;  // the server's own notes: "📞 started a call", "📌 pinned..."
  return (
    // Pressable: a long press (half a second) opens the menu for this message.
    <Pressable
      onLongPress={() => onLongPress(message)}
      style={({ pressed }) => [styles.message, pressed && styles.messagePressed]}
    >
      {message.reply ? (
        <Text style={styles.reply} numberOfLines={1}>
          ↪ {message.reply.deleted
            ? 'A deleted message'
            : `${message.reply.name}: ${readableText(message.reply.text, users, emoji) || 'Attachment'}`}
        </Text>
      ) : null}
      <View style={styles.top}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.time}>{when(message.sent_at)}</Text>
      </View>
      {text ? (
        <Text style={[styles.text, note && styles.note]}>
          {text}
          {message.edited_at ? <Text style={styles.time}> (edited)</Text> : null}
        </Text>
      ) : null}
      {message.file ? (
        <Text style={styles.file}>
          {message.file.image ? '🖼️' : '📎'} {message.file.filename}
        </Text>
      ) : null}
      {message.reactions.length > 0 ? (
        // flexWrap: chips that don't fit on one line go on to the next.
        <View style={styles.reactions}>
          {message.reactions.map((reaction) => {
            const mine = reaction.user_ids.includes(myId);
            return (
              <Pressable
                key={reaction.emoji}
                onPress={() => onReact(message.id, reaction.emoji)}  // add ours, or take it back
                style={[styles.chip, mine && styles.chipMine]}
              >
                <Text style={styles.chipText}>
                  {reactionLabel(reaction.emoji, emoji)} {reaction.user_ids.length}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </Pressable>
  );
}

// The long-press menu: a Modal is a popup drawn over everything else. "transparent" lets the chat
// show through behind it; tapping that dark backdrop (or Android's back button: onRequestClose)
// closes it.
function MessageMenu({ message, canChange, onClose, onReact, onReply, onEdit, onDelete }) {
  // A Modal covers the whole screen, navigation bar included (outside App.js's SafeAreaView),
  // so the menu leaves room for that bar itself: insets.bottom is its height.
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* A Pressable without onPress inside: taps on the menu itself don't reach the backdrop. */}
        <Pressable style={[styles.menu, { paddingBottom: insets.bottom + 8 }]}>
          <View style={styles.quickReactions}>
            {QUICK_REACTIONS.map((reaction) => (
              <Pressable
                key={reaction}
                onPress={() => onReact(message.id, reaction)}
                style={({ pressed }) => [styles.quickReaction, pressed && styles.messagePressed]}
              >
                <Text style={styles.quickReactionText}>{reaction}</Text>
              </Pressable>
            ))}
          </View>
          <MenuItem label="Reply" onPress={onReply} />
          {canChange && message.kind === null ? <MenuItem label="Edit" onPress={onEdit} /> : null}
          {canChange ? <MenuItem label="Delete" onPress={onDelete} danger /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MenuItem({ label, onPress, danger }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.messagePressed]}>
      <Text style={[styles.menuText, danger && styles.danger]}>{label}</Text>
    </Pressable>
  );
}

export default function ChatScreen({ connection }) {
  const { current, messages, users, emoji, me, closeChat, status } = connection;
  const [draft, setDraft] = useState('');          // what's in the text box
  const [menuFor, setMenuFor] = useState(null);    // the message whose menu is open
  const [replyTo, setReplyTo] = useState(null);    // the message we're replying to
  const [editing, setEditing] = useState(null);    // the message we're editing
  // A ref to the text box itself (not its text): input.current.focus() puts the cursor in it,
  // which opens the keyboard. React fills it in through the TextInput's ref={input}.
  const input = useRef(null);

  const isAdmin = users[me.id]?.admin === true;

  // Android's back button (or back gesture) goes back to the list instead of leaving the app.
  // Returning true says "handled". The function useEffect returns removes the listener again
  // when this screen goes away.
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      closeChat();
      return true;
    });
    return () => listener.remove();
  }, []);

  function send() {
    const text = draft.trim();
    if (!text) return;
    if (editing) {
      connection.editMessage(editing.id, text);
      setEditing(null);
    } else {
      connection.sendMessage(text, replyTo?.id);
      setReplyTo(null);
    }
    setDraft('');
  }

  function react(messageId, reaction) {
    connection.react(messageId, reaction);
    setMenuFor(null);
  }

  function startReply() {
    setReplyTo(menuFor);
    if (editing) {  // replying instead of editing: the edit's text doesn't belong in the box
      setEditing(null);
      setDraft('');
    }
    setMenuFor(null);
    focusTextBox();
  }

  function startEdit() {
    setEditing(menuFor);
    setReplyTo(null);
    setDraft(readableText(menuFor.text, users, emoji));  // "@kari", not "<@2>", in the box
    setMenuFor(null);
    focusTextBox();
  }

  // Ready to type after Reply or Edit. A moment later: the menu's popup is still closing, and
  // Android won't open the keyboard for a box behind it.
  function focusTextBox() {
    setTimeout(() => input.current?.focus(), 100);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft('');
  }

  function confirmDelete() {
    const message = menuFor;
    setMenuFor(null);
    // Android's own dialog. The buttons' onPress runs when one is tapped.
    Alert.alert('Delete message?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => connection.deleteMessage(message.id) },
    ]);
  }

  let body;
  if (messages === null) {
    body = <ActivityIndicator style={styles.middle} color={colors.textMuted} size="large" />;
  } else if (messages.length === 0) {
    body = <Text style={[styles.middle, styles.empty]}>No messages yet. Say hi!</Text>;
  } else {
    // inverted: the list is drawn upside down, so it starts at the bottom like a chat, and a new
    // message appears at the bottom without scrolling. So it gets the messages newest first.
    body = (
      <FlatList
        inverted
        data={[...messages].reverse()}
        keyExtractor={(message) => String(message.id)}
        renderItem={({ item }) => (
          <Message
            message={item} users={users} emoji={emoji} myId={me.id}
            onLongPress={setMenuFor} onReact={connection.react}
          />
        )}
        contentContainerStyle={styles.listInside}
        keyboardShouldPersistTaps="handled"  // a tap on a chip works even while the keyboard is up
      />
    );
  }

  const replyName = replyTo && ((replyTo.user_id && users[replyTo.user_id]?.name) || replyTo.name);

  return (
    // KeyboardAvoidingView: when the keyboard opens, it adds room at the bottom the keyboard's
    // height, so the text box moves up above it instead of being hidden behind it.
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={styles.header}>
        <Pressable onPress={closeChat} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{chatTitle(current, connection)}</Text>
      </View>
      {status !== 'online' ? <Text style={styles.offline}>Reconnecting…</Text> : null}
      {body}

      {replyTo || editing ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText} numberOfLines={1}>
            {editing ? 'Editing message' : `Replying to ${replyName}`}
          </Text>
          <Pressable onPress={editing ? cancelEdit : () => setReplyTo(null)} hitSlop={12}>
            <Text style={styles.bannerClose}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.composer}>
        <TextInput
          ref={input}
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={`Message ${chatTitle(current, connection)}`}
          placeholderTextColor={colors.textMuted}
          multiline                          // grows with the text, up to maxHeight
          maxLength={me.maxTextLength}       // the server's limit (from "welcome")
        />
        <Pressable
          onPress={send}
          disabled={!draft.trim()}
          style={({ pressed }) => [styles.send, !draft.trim() && styles.sendOff, pressed && styles.messagePressed]}
        >
          <Text style={styles.sendText}>{editing ? 'Save' : 'Send'}</Text>
        </Pressable>
      </View>

      {menuFor ? (
        <MessageMenu
          message={menuFor}
          canChange={menuFor.user_id === me.id || isAdmin}  // the server's rule too
          onClose={() => setMenuFor(null)}
          onReact={react}
          onReply={startReply}
          onEdit={startEdit}
          onDelete={confirmDelete}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: colors.bgMain, borderBottomWidth: 1, borderBottomColor: colors.bgDarkest,
  },
  back: { paddingRight: 12 },
  backText: { color: colors.textSoft, fontSize: 24 },
  title: { flex: 1, color: colors.textStrong, fontSize: 18, fontWeight: 'bold' },
  offline: { backgroundColor: colors.red, color: colors.textStrong, textAlign: 'center', paddingVertical: 4 },
  middle: { flex: 1, textAlignVertical: 'center', textAlign: 'center' },
  empty: { color: colors.textMuted },
  listInside: { paddingVertical: 8 },
  message: { paddingHorizontal: 16, paddingVertical: 6 },
  messagePressed: { backgroundColor: colors.bgActive },
  reply: { color: colors.textMuted, fontSize: 13, marginBottom: 2 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { color: colors.textStrong, fontSize: 15, fontWeight: 'bold' },
  time: { color: colors.textMuted, fontSize: 12, fontWeight: 'normal' },
  text: { color: colors.text, fontSize: 15, marginTop: 2 },
  note: { color: colors.textMuted, fontStyle: 'italic' },
  file: { color: colors.textSoft, fontSize: 14, marginTop: 4 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: {
    flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: colors.bgPanel, borderWidth: 1, borderColor: colors.bgPanel,
  },
  chipMine: { borderColor: colors.accent, backgroundColor: colors.bgActive },
  chipText: { color: colors.text, fontSize: 14 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  menu: { backgroundColor: colors.bgPanel, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  quickReactions: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12 },
  quickReaction: { padding: 8, borderRadius: 24 },
  quickReactionText: { fontSize: 28 },
  menuItem: { paddingHorizontal: 20, paddingVertical: 14 },
  menuText: { color: colors.text, fontSize: 16 },
  danger: { color: colors.red },
  banner: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: colors.bgPanel,
  },
  bannerText: { flex: 1, color: colors.textSoft },
  bannerClose: { color: colors.textSoft, fontSize: 16 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8 },
  input: {
    flex: 1, maxHeight: 120, backgroundColor: colors.bgDarkest, color: colors.text, fontSize: 16,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
  },
  send: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  sendOff: { opacity: 0.4 },
  sendText: { color: colors.textStrong, fontWeight: 'bold' },
});
