// One chat: its messages, drawn like the web page's (messages.js, showMessage), and writing.
// The top bar is App.js's; this is everything under it.
import { useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text,
  TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import { colors } from './colors';
import { chatLabel } from './chats';
import { Avatar, BotBadge, nameColor } from './people';

// The reactions in the long-press menu (a full emoji picker comes later).
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

// A message from the same person within 5 minutes joins the one before (no picture or name).
const GROUP_MINUTES = 5;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// ----- Times, like the web page: "Today", "Yesterday", "10 October 2026", and "14:03".

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function dayName(date) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, new Date())) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function clock(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

// Above a message: "Today at 14:03", "Yesterday at 09:12", "10 October 2026 14:03".
function headerTime(date) {
  const day = dayName(date);
  return (day === 'Today' || day === 'Yesterday' ? day + ' at ' : day + ' ') + clock(date);
}

// ----- Text

// Messages store mentions and custom emoji by id ("<@3>", "<@everyone>", "<:17>"), so renames
// show the new name. Turn them back into words: "@kari", ":pog:" (the pictures come later).
function readableText(text, users, emoji) {
  return text
    .replace(/<@(\d+)>/g, (whole, id) => '@' + (users[id]?.name ?? 'someone'))
    .replace(/<@everyone>/g, '@everyone')
    .replace(/<:(\d+)>/g, (whole, id) => (emoji[id] ? `:${emoji[id]}:` : ':?:'));
}

// Does this text mention us (by name, or with @everyone)?
function mentionsMe(text, myId) {
  return text.includes(`<@${myId}>`) || text.includes('<@everyone>');
}

// A message's text with its @mentions drawn tinted (.mention). split() with a (group) keeps the
// separators: "hi <@3>!" -> ["hi ", "<@3>", "!"]. A <Text> inside a <Text> carries on the same
// line with its own style, like a <span> in HTML.
function MessageText({ text, users, emoji }) {
  return text.split(/(<@\d+>|<@everyone>)/).map((part, index) => (/^<@(\d+|everyone)>$/.test(part)
    ? <Text key={index} style={styles.mention}>{readableText(part, users, emoji)}</Text>
    : readableText(part, users, emoji)));
}

// A reaction is an emoji, or a custom emoji as "custom:17": shown by name until we draw pictures.
function reactionLabel(reaction, emoji) {
  const custom = reaction.match(/^custom:(\d+)$/);
  return custom ? `:${emoji[custom[1]] ?? '?'}:` : reaction;
}

// Who can be @mentioned here (besides us): in a DM the other person, and the bots (naming one
// invites it in, see the server's bot_invited); in a group its members; in a channel everyone.
function chatPeople(key, { users, groups, me }) {
  const everyone = Object.values(users).filter((user) => user.id !== me.id);
  if (key.startsWith('dm:')) {
    const ids = key.slice(3).split(':').map(Number);
    return everyone.filter((user) => ids.includes(user.id) || user.bot);
  }
  const group = groups.find((g) => g.key === key);
  if (group) return everyone.filter((user) => group.members.includes(user.id));
  return everyone;
}

// ----- The list's rows

// The messages (oldest first) as the rows to draw, with the web page's rules: a date line before
// a new day, the NEW line above the first unread message, and grouping.
function buildRows(messages, lastRead, blocked) {
  const rows = [];
  let last = null;  // the previous message: {sender, time}
  let newDrawn = false;
  for (const message of messages) {
    const time = new Date(message.sent_at);
    const sender = message.user_id ?? 'name:' + message.name;  // (messages from before accounts: by name)
    const newDay = last === null || !isSameDay(last.time, time);
    if (newDay) rows.push({ key: 'day' + message.id, type: 'day', label: dayName(time) });
    const firstNew = lastRead !== null && !newDrawn && message.id > lastRead;
    if (firstNew) {
      rows.push({ key: 'new', type: 'new' });
      newDrawn = true;
    }
    // A reply starts a new group (its quote sits above a name), and so does the first new message.
    const grouped = !newDay && !firstNew && !message.reply && last.sender === sender &&
      time - last.time < GROUP_MINUTES * 60 * 1000;
    last = { sender: blocked.includes(message.user_id) ? 'blocked' : sender, time };
    rows.push({ key: String(message.id), type: 'message', message, grouped });
  }
  return rows;
}

function Message({ message, grouped, connection, isBlocked, onShow, onLongPress }) {
  const { users, roles, emoji, me } = connection;
  const sender = users[message.user_id];
  const name = sender?.name ?? message.name;

  // Someone we blocked: a line instead of the message, until Show.
  if (isBlocked) {
    return (
      <View style={[styles.message, styles.blockedRow]}>
        <Icon name="ban" size={16} color={colors.textMuted} />
        <Text style={styles.blocked}>
          A message from someone you blocked · <Text style={styles.show} onPress={() => onShow(message.id)}>Show</Text>
        </Text>
      </View>
    );
  }

  const note = message.kind !== null;  // the server's own notes: "📞 Call · 12 min", "📌 pinned a message."
  return (
    // A long press (half a second) opens the menu: on a phone it stands in for the web page's bar
    // of buttons that appears when the mouse is over a message.
    <Pressable
      onLongPress={() => onLongPress(message)}
      style={({ pressed }) => [
        styles.message,
        grouped ? styles.grouped : styles.groupStart,
        mentionsMe(message.text, me.id) && message.user_id !== me.id && styles.mentionsMe,
        pressed && styles.pressed,
      ]}
    >
      {/* The picture's column: the picture, or (grouped) an empty space as wide as one. */}
      {grouped ? <View style={styles.pictureSpace} /> : <Avatar user={sender} name={name} size={40} />}
      <View style={styles.body}>
        {message.reply ? <ReplyLine reply={message.reply} connection={connection} /> : null}
        {grouped ? null : (
          <View style={styles.header}>
            <Text style={[styles.name, { color: nameColor(sender, roles) ?? colors.textStrong }]}>{name}</Text>
            {sender?.bot ? <BotBadge /> : null}
            <Text style={styles.time}>{headerTime(new Date(message.sent_at))}</Text>
          </View>
        )}
        {message.text ? (
          <Text style={[styles.text, note && styles.note]}>
            <MessageText text={message.text} users={users} emoji={emoji} />
            {message.edited_at ? <Text style={styles.edited}> (edited)</Text> : null}
          </Text>
        ) : null}
        {message.file ? (
          <View style={styles.file}>
            <Icon name={message.file.image ? 'image' : 'paperclip'} size={16} color={colors.textSoft} />
            <Text style={styles.fileName}>{message.file.filename}</Text>
          </View>
        ) : null}
        {message.reactions.length > 0 ? (
          <View style={styles.reactions}>
            {message.reactions.map((reaction) => {
              const mine = reaction.user_ids.includes(me.id);
              return (
                <Pressable
                  key={reaction.emoji}
                  onPress={() => connection.react(message.id, reaction.emoji)}  // add ours, or take it back
                  style={[styles.chip, mine && styles.chipMine]}
                >
                  <Text style={styles.chipText}>{reactionLabel(reaction.emoji, emoji)} {reaction.user_ids.length}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// The quote above a reply: the reply icon, the original's sender (small picture, name) and its start.
function ReplyLine({ reply, connection }) {
  const { users, emoji } = connection;
  if (reply.deleted) {
    return (
      <View style={styles.replyLine}>
        <Icon name="reply" size={14} color={colors.textMuted} />
        <Text style={[styles.replyText, styles.note]}>Original message was deleted</Text>
      </View>
    );
  }
  return (
    <View style={styles.replyLine}>
      <Icon name="reply" size={14} color={colors.textMuted} />
      <Avatar user={users[reply.user_id]} name={reply.name} size={16} />
      <Text style={styles.replyName}>{users[reply.user_id]?.name ?? reply.name}</Text>
      <Text numberOfLines={1} style={styles.replyText}>
        {reply.text ? readableText(reply.text, users, emoji) : reply.file ? 'Attachment' : ''}
      </Text>
    </View>
  );
}

// The long-press menu, a sheet from the bottom. The same choices, in the same order, as the web
// page's bar on a message: reactions, Reply, Pin, Edit, Delete.
function MessageMenu({ message, canChange, onClose, onReact, onReply, onPin, onEdit, onDelete }) {
  // A Modal covers the whole screen, navigation bar included, so the sheet leaves room for that
  // bar itself: insets.bottom is its height.
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* A Pressable without onPress inside: taps on the sheet itself don't reach the backdrop. */}
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}>
          <View style={styles.quickReactions}>
            {QUICK_REACTIONS.map((reaction) => (
              <Pressable
                key={reaction}
                onPress={() => onReact(message.id, reaction)}
                style={({ pressed }) => [styles.quickReaction, pressed && styles.pressed]}
              >
                <Text style={styles.quickReactionText}>{reaction}</Text>
              </Pressable>
            ))}
          </View>
          <MenuItem icon="reply" label="Reply" onPress={onReply} />
          {message.kind === null ? <MenuItem icon="pin" label={message.pinned ? 'Unpin' : 'Pin'} onPress={onPin} /> : null}
          {canChange && message.kind === null ? <MenuItem icon="pencil" label="Edit" onPress={onEdit} /> : null}
          {canChange ? <MenuItem icon="trash-2" label="Delete" onPress={onDelete} danger /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MenuItem({ icon, label, onPress, danger }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
      <Icon name={icon} color={danger ? colors.red : colors.icon} />
      <Text style={[styles.menuText, danger && styles.danger]}>{label}</Text>
    </Pressable>
  );
}

export default function ChatScreen({ connection }) {
  const { current, messages, users, roles, me, lastRead, more, blocked } = connection;
  const [draft, setDraft] = useState('');          // what's in the text box
  const [menuFor, setMenuFor] = useState(null);    // the message whose menu is open
  const [replyTo, setReplyTo] = useState(null);    // the message we're replying to
  const [editing, setEditing] = useState(null);    // the message we're editing
  const [cursor, setCursor] = useState(0);         // where the cursor is in the text box
  const [shownBlocked, setShownBlocked] = useState(new Set());  // blocked people's messages we chose to see
  // A ref to the text box itself (not its text): input.current.focus() puts the cursor in it.
  const input = useRef(null);

  const label = chatLabel(current, connection);
  const isAdmin = users[me.id]?.admin === true;

  // @ suggestions: is the word just before the cursor an "@" and the start of a name? Then offer
  // the people in this chat whose names start with it (and @everyone in a channel), up to 5.
  const typedMention = draft.slice(0, cursor).match(/(?:^|\s)@([\w-]*)$/);  // [whole match, "ka"]
  let suggestions = [];
  if (typedMention) {
    const start = typedMention[1].toLowerCase();
    suggestions = chatPeople(current, connection).filter((user) => user.name.toLowerCase().startsWith(start));
    const isChannel = !current.startsWith('dm:') && !current.startsWith('g:');
    if (isChannel && 'everyone'.startsWith(start)) suggestions.push({ id: 'everyone', name: 'everyone' });
    suggestions = suggestions.slice(0, 5);
  }

  // Swap the half-typed "@ka" before the cursor for the whole "@kari " (the server turns it into
  // a mention when the message is sent).
  function pickSuggestion(name) {
    const before = draft.slice(0, cursor).replace(/@[\w-]*$/, `@${name} `);
    setDraft(before + draft.slice(cursor));
    setCursor(before.length);
  }

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

  // Ready to type after Reply or Edit. A moment later: the menu's popup is still closing, and
  // Android won't open the keyboard for a box behind it.
  function focusTextBox() {
    setTimeout(() => input.current?.focus(), 100);
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

  // Editing happens in the text box at the bottom, with an "Editing message" bar. (The web page
  // edits inside the message itself; on a phone the keyboard would cover it.)
  function startEdit() {
    setEditing(menuFor);
    setReplyTo(null);
    setDraft(readableText(menuFor.text, users, connection.emoji));  // "@kari", not "<@2>", in the box
    setMenuFor(null);
    focusTextBox();
  }

  function cancelEdit() {
    setEditing(null);
    setDraft('');
  }

  function togglePin() {
    connection.pin(menuFor.id, !menuFor.pinned);
    setMenuFor(null);
  }

  function confirmDelete() {
    const message = menuFor;
    setMenuFor(null);
    Alert.alert('Delete message?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => connection.deleteMessage(message.id) },
    ]);
  }

  function renderRow({ item }) {
    if (item.type === 'day') {
      return (
        <View style={styles.dateDivider}>
          <View style={styles.dateLine} />
          <Text style={styles.dateText}>{item.label}</Text>
          <View style={styles.dateLine} />
        </View>
      );
    }
    if (item.type === 'new') {
      return (
        <View style={styles.newDivider}>
          <View style={styles.newLine} />
          <Text style={styles.newTag}>NEW</Text>
        </View>
      );
    }
    if (item.type === 'start') return <Text style={styles.channelStart}>This is the beginning of {label}.</Text>;
    return (
      <Message
        message={item.message} grouped={item.grouped} connection={connection}
        isBlocked={blocked.includes(item.message.user_id) && !shownBlocked.has(item.message.id)}
        onShow={(id) => setShownBlocked((old) => new Set(old).add(id))}
        onLongPress={setMenuFor}
      />
    );
  }

  let body;
  if (messages === null) {
    body = <ActivityIndicator style={styles.middle} color={colors.textMuted} size="large" />;
  } else {
    const rows = buildRows(messages, lastRead, blocked);
    if (!more) rows.unshift({ key: 'start', type: 'start' });  // nothing older: the chat's beginning
    // inverted: the list is drawn upside down, so it starts at the bottom like a chat, and a new
    // message appears at the bottom without scrolling. So it gets the rows newest first, and its
    // "end" is the top: getting near it (onEndReached) asks for older messages.
    body = (
      <FlatList
        inverted
        data={rows.reverse()}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        contentContainerStyle={styles.listInside}
        keyboardShouldPersistTaps="handled"  // a tap on a chip works even while the keyboard is up
        onEndReached={connection.loadOlder}
        onEndReachedThreshold={0.5}
      />
    );
  }

  const replyName = replyTo && (users[replyTo.user_id]?.name ?? replyTo.name);

  return (
    // KeyboardAvoidingView: when the keyboard opens, it adds room at the bottom the keyboard's
    // height, so the text box moves up above it instead of being hidden behind it.
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      {body}

      {suggestions.length > 0 ? (
        // The web page's #autocomplete: a box just above the text box, a row per person.
        <View style={styles.autocomplete}>
          {suggestions.map((user) => (
            <Pressable
              key={user.id}
              onPress={() => pickSuggestion(user.name)}
              style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
            >
              {user.id === 'everyone'
                ? <Text style={styles.suggestionAt}>@</Text>
                : <Avatar user={user} size={24} />}
              <Text style={[styles.suggestionName, { color: nameColor(user, roles) ?? colors.text }]}>{user.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {replyTo || editing ? (
        // The web page's #reply-bar: "Replying to kari ×".
        <View style={styles.replyBar}>
          <Text style={styles.replyBarText} numberOfLines={1}>
            {editing ? 'Editing message' : <>Replying to <Text style={styles.replyBarName}>{replyName}</Text></>}
          </Text>
          <Pressable onPress={editing ? cancelEdit : () => setReplyTo(null)} hitSlop={12}>
            <Icon name="x" size={18} color={colors.textSoft} />
          </Pressable>
        </View>
      ) : null}
      <View style={styles.form}>
        <TextInput
          ref={input}
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSelectionChange={(event) => setCursor(event.nativeEvent.selection.end)}  // for the @ suggestions
          placeholder={`Message ${label}`}
          placeholderTextColor={colors.textMuted}
          multiline                          // grows with the text, up to maxHeight
          maxLength={me.maxTextLength}       // the server's limit (from "welcome")
        />
        <Pressable
          onPress={send}
          disabled={!draft.trim()}
          style={({ pressed }) => [styles.send, pressed && styles.sendPressed]}
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
          onPin={togglePin}
          onEdit={startEdit}
          onDelete={confirmDelete}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

// The web page's sizes (chat.css), with its rem as 16 px: 0.75rem = 12, 0.85rem = 13.6, and so on.
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  middle: { flex: 1 },
  listInside: { padding: 12 },  // #messages on a phone: 12px
  // .message: the picture's column and the body side by side, 12px apart.
  message: { flexDirection: 'row', gap: 12, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 4 },
  groupStart: { marginTop: 8 },
  grouped: { paddingVertical: 1 },
  pressed: { backgroundColor: colors.bgHoverDim },
  // A message mentioning us: 8% yellow behind it, and a 2px yellow line on its left.
  mentionsMe: { backgroundColor: colors.yellow8, borderLeftWidth: 2, borderLeftColor: colors.yellow, paddingLeft: 2 },
  pictureSpace: { width: 40 },
  body: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  name: { fontSize: 16, fontWeight: '600' },
  time: { fontSize: 12, color: colors.textMuted },
  text: { fontSize: 16, lineHeight: 22, color: colors.text },
  note: { color: colors.textMuted, fontStyle: 'italic' },
  edited: { fontSize: 11.2, color: colors.textMuted, fontStyle: 'normal' },
  mention: { backgroundColor: colors.accent30, color: colors.mentionText, fontWeight: '500' },
  file: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  fileName: { color: colors.textSoft, fontSize: 14 },
  blockedRow: { alignItems: 'center', gap: 8, marginTop: 8 },
  blocked: { flex: 1, color: colors.textMuted, fontSize: 14 },
  show: { color: colors.link },
  // .reply-line: 0.8rem, muted, the name bold in --text-soft.
  replyLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  replyName: { fontSize: 12.8, fontWeight: '700', color: colors.textSoft },
  replyText: { flex: 1, fontSize: 12.8, color: colors.textMuted },
  // .reactions and .reaction-chip.
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  chip: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: 'transparent',
    backgroundColor: colors.bgPanel,
  },
  chipMine: { borderColor: colors.accent, backgroundColor: colors.accent15 },
  chipText: { fontSize: 13.6, color: colors.text },
  // .date-divider: "──── Today ────".
  dateDivider: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 4 },
  dateLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dateText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  // .new-divider: a red line ending in a red NEW tag.
  newDivider: { flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 4 },
  newLine: { flex: 1, height: 1, backgroundColor: colors.red },
  newTag: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
    backgroundColor: colors.red, color: '#ffffff', fontSize: 10.4, fontWeight: '700',
  },
  channelStart: { marginTop: 8, marginBottom: 16, fontSize: 13.6, color: colors.textMuted },
  // The long-press sheet.
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  sheet: { backgroundColor: colors.bgPanel, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  quickReactions: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12 },
  quickReaction: { padding: 8, borderRadius: 24 },
  quickReactionText: { fontSize: 28 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  menuText: { color: colors.text, fontSize: 16 },
  danger: { color: colors.red },
  // #autocomplete.
  autocomplete: {
    marginHorizontal: 8, padding: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
    backgroundColor: colors.bgPanel,
  },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  suggestionPressed: { backgroundColor: colors.bgHover },
  suggestionAt: { width: 24, textAlign: 'center', fontSize: 18, color: colors.textMuted },
  suggestionName: { fontSize: 16 },
  // #reply-bar.
  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8, paddingHorizontal: 12,
    paddingVertical: 6, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: colors.bgPanel,
  },
  replyBarText: { flex: 1, fontSize: 13.6, color: colors.textSoft },
  replyBarName: { color: colors.textStrong, fontWeight: '700' },
  // #chat-form on a phone: gap 6px, padding 8px; the box and Send as on the web page.
  form: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, padding: 8 },
  input: {
    flex: 1, maxHeight: 200, backgroundColor: colors.bgInput, color: colors.text, fontSize: 16,
    lineHeight: 22, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
  },
  send: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11 },
  sendPressed: { opacity: 0.8 },
  sendText: { color: '#ffffff', fontSize: 16 },
});
