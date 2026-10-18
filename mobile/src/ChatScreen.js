// One chat: its messages, drawn like the web page's (messages.js, showMessage), and writing.
// The top bar is App.js's; this is everything under it.
import { useEffect, useRef, useState } from 'react';
import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator, Alert, Animated, BackHandler, Easing, FlatList, Image, Keyboard, Modal, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import Icon from './Icon';
import MessageText, { Attachment, CustomEmoji, LinkPreview, formatSize } from './MessageText';
import ChatInfoScreen from './ChatInfoScreen';
import PinsScreen from './PinsScreen';
import Picker from './Picker';
import SearchScreen from './SearchScreen';
import { useStyles, useTheme } from './theme';
import { chatLabel } from './chats';
import { SERVER } from './config';
import { MAX_TRAY_FILES, uploadFile } from './files';
import { copySharedFile } from '../modules/shared-files';
import { Avatar, BotBadge, nameColor } from './people';
import { dayName, headerTime, isSameDay } from './time';
import { limits, megabytes } from './limits';

// Quick reactions in the long-press menu, before its smiley (which opens the whole emoji picker).
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

// At most this many suggestions while typing ":" or "@" (the web page's MAX_SUGGESTIONS).
const MAX_SUGGESTIONS = 10;

// A message from the same person within 5 minutes joins the one before (no picture or name).
const GROUP_MINUTES = 5;

// The character counter shows this close to the limit (the web page's COUNT_FROM).
const COUNT_FROM = 200;

// Statuses in words, for the @ suggestions (the web page's PRESENCE_NAMES, lower case).
const PRESENCE_NAMES = { online: 'online', idle: 'idle', dnd: 'do not disturb' };

// Going to a message further up (a pin, a search result, a reply's quote): at most this many batches
// of 50 older messages are loaded to reach it (2,000 messages, like the web page's MAX_JUMP_BATCHES).
const MAX_JUMP_BATCHES = 40;

// ----- Text

// Messages store mentions and custom emoji by id ("<@3>", "<@everyone>", "<:17>"), so renames
// show the new name. Turn them back into what's typed: "@kari", ":pog:". (For the reply quote's
// line and the text box when editing; messages themselves are drawn by MessageText.)
function readableText(text, users, emoji) {
  return text
    .replace(/<@(\d+)>/g, (whole, id) => '@' + (users[id]?.name ?? 'unknown'))
    .replace(/<@everyone>/g, '@everyone')
    .replace(/<:(\d+)>/g, (whole, id) => (emoji[id] ? `:${emoji[id].name}:` : ':deleted:'));
}

// Does this text mention us (by name, or with @everyone)?
function mentionsMe(text, myId) {
  return text.includes(`<@${myId}>`) || text.includes('<@everyone>');
}

// A reaction's emoji: a Unicode one as itself, a custom one ("custom:17") as its picture, 18 px.
function ReactionEmoji({ reaction, emoji }) {
  const styles = useStyles(makeStyles);
  const custom = reaction.match(/^custom:(\d+)$/);
  return custom ? <CustomEmoji item={emoji[custom[1]]} size={18} /> : <Text style={styles.chipText}>{reaction}</Text>;
}

// The ":" suggestions (the web page's findSuggestions): custom emoji whose names start with what's
// typed, then those that contain it; then Unicode emoji by name (with _ for spaces), best first:
// the whole name, the name's start, a later word's start, anywhere; shorter names first.
function findEmoji(typed, { emoji, emojiGroups, users }) {
  const query = typed.toLowerCase();
  const customs = Object.values(emoji);
  const found = [
    ...customs.filter((item) => item.name.toLowerCase().startsWith(query)),
    ...customs.filter((item) => !item.name.toLowerCase().startsWith(query) && item.name.toLowerCase().includes(query)),
  ].map((item) => ({ key: 'custom:' + item.id, custom: item, label: `:${item.name}:`, detail: users[item.owner_id]?.name, insert: `:${item.name}: ` }));
  const words = query.replace(/_/g, ' ');
  const rank = (name) => {
    if (name === words) return 0;
    if (name.startsWith(words)) return 1;
    if (name.includes(' ' + words)) return 2;
    return name.includes(words) ? 3 : null;
  };
  const unicode = [];
  for (const group of emojiGroups ?? []) {
    for (const [character, name] of group.emoji) {
      const score = rank(name.toLowerCase());
      if (score !== null) unicode.push({ score, name, character });
    }
  }
  unicode.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  for (const { character, name } of unicode) {
    found.push({ key: character, character, label: name, insert: character });
  }
  return found.slice(0, MAX_SUGGESTIONS);
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

// A message we jumped to lights up and fades out over 2 seconds (chat.css's .message.flash).
// Drawn behind the message; `key` gives every jump a new one, so it starts over.
function Flash() {
  const styles = useStyles(makeStyles);
  // An Animated.Value is a number React Native can change smoothly, frame by frame, without
  // redrawing the component: here the highlight's opacity, from 1 to 0.
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    // useNativeDriver: Android's side runs the animation by itself, so it stays smooth.
    Animated.timing(fade, { toValue: 0, duration: 2000, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
  }, []);
  return <Animated.View pointerEvents="none" style={[styles.flash, { opacity: fade }]} />;
}

// flash: a number while it should light up (a new number lights it up again).
// onJump(messageId): go to a message in this chat (the reply's quote). onProfile(id), onUserMenu(id):
// a tap on the picture or name opens their profile, a long press the user menu.
function Message({ message, grouped, connection, isBlocked, flash, onShow, onLongPress, onJump, onProfile, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
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

  // A long press on a reaction: who reacted, by their current names (the web page shows them on hover).
  function whoReacted(reaction) {
    const custom = reaction.emoji.match(/^custom:(\d+)$/);
    const title = custom ? `:${emoji[custom[1]]?.name ?? 'deleted'}:` : reaction.emoji;
    Alert.alert(title, reaction.user_ids.map((id) => users[id]?.name ?? 'someone').join(', '));
  }
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
      {flash ? <Flash key={flash} /> : null}
      {/* The picture's column: the picture, or (grouped) an empty space as wide as one. */}
      {/* The picture and the name are touch areas of their own inside the message's: a touch goes to the
          innermost one that wants it, so a long press here opens the user menu instead of the message's.
          (Not for messages from before accounts, which have nobody behind them.) */}
      {grouped ? <View style={styles.pictureSpace} /> : (
        <Pressable
          disabled={!sender}
          onPress={() => onProfile(sender.id)}
          onLongPress={() => onUserMenu(sender.id)}
          style={styles.pictureTouch}
        >
          <Avatar user={sender} name={name} size={40} />
        </Pressable>
      )}
      <View style={styles.body}>
        {message.reply ? <ReplyLine reply={message.reply} connection={connection} onJump={onJump} /> : null}
        {grouped ? null : (
          <View style={styles.header}>
            <Pressable disabled={!sender} onPress={() => onProfile(sender.id)} onLongPress={() => onUserMenu(sender.id)}>
              <Text style={[styles.name, { color: nameColor(sender, roles) ?? colors.textStrong }]}>{name}</Text>
            </Pressable>
            {sender?.bot ? <BotBadge /> : null}
            <Text style={styles.time}>{headerTime(new Date(message.sent_at))}</Text>
          </View>
        )}
        {/* Then, like the web page: the text, the attached file, the link's preview card, the reactions. */}
        {message.text ? (
          <MessageText text={message.text} users={users} emoji={emoji} edited={message.edited_at} note={note} onMention={onProfile} />
        ) : null}
        {message.file ? (
          <Attachment file={message.file} sender={message.user_id === me.id ? null : name} onLongPress={() => onLongPress(message)} />
        ) : null}
        {message.preview ? <LinkPreview preview={message.preview} /> : null}
        {message.reactions.length > 0 ? (
          <View style={styles.reactions}>
            {message.reactions.map((reaction) => {
              const mine = reaction.user_ids.includes(me.id);
              return (
                <Pressable
                  key={reaction.emoji}
                  onPress={() => connection.react(message.id, reaction.emoji)}  // add ours, or take it back
                  onLongPress={() => whoReacted(reaction)}
                  style={[styles.chip, mine && styles.chipMine]}
                >
                  <ReactionEmoji reaction={reaction.emoji} emoji={emoji} />
                  <Text style={styles.chipText}>{reaction.user_ids.length}</Text>
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
// A tap goes to the original (like a click on the web page).
function ReplyLine({ reply, connection, onJump }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
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
    <Pressable style={styles.replyLine} onPress={() => onJump(reply.id)}>
      <Icon name="reply" size={14} color={colors.textMuted} />
      <Avatar user={users[reply.user_id]} name={reply.name} size={16} />
      <Text style={styles.replyName}>{users[reply.user_id]?.name ?? reply.name}</Text>
      <Text numberOfLines={1} style={styles.replyText}>{replyContent(reply, users, emoji, styles, colors)}</Text>
    </Pressable>
  );
}

// A message of ours on its way (connection.js, the outbox), at the bottom: faded until the server has it
// (then the real one takes its place), with "Sending…" if that takes a while; if it didn't get there,
// red with Retry and Delete. (A phone's connection is shakier than a PC's, so the web page has none.)
function PendingMessage({ item, connection }) {
  const styles = useStyles(makeStyles);
  const { users, emoji } = connection;
  const [slow, setSlow] = useState(false);  // (most go in a blink: no "Sending…" flashing by)
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(timer);
  }, [item.since]);
  return (
    <View style={[styles.message, styles.grouped]}>
      <View style={styles.pictureSpace} />
      <View style={styles.body}>
        <View style={item.failed ? null : styles.sending}>
          {item.text ? <MessageText text={item.text} users={users} emoji={emoji} edited={null} note={false} /> : null}
          {item.file && !item.text ? <Text style={styles.pendingNote}>A file</Text> : null}
        </View>
        {item.failed ? (
          <Text style={styles.pendingFailed}>
            Couldn't send.{' '}
            <Text style={styles.pendingAction} onPress={() => connection.retryMessage(item.nonce)}>Retry</Text>
            {' · '}
            <Text style={styles.pendingAction} onPress={() => connection.discardMessage(item.nonce)}>Delete</Text>
          </Text>
        ) : slow ? <Text style={styles.pendingNote}>Sending…</Text> : null}
      </View>
    </View>
  );
}

// A reply quote's text the web page's way (fillWithEmoji): custom emoji as small pictures, mentions
// highlighted, the rest as it is; a file without text: a paperclip and "Attachment".
function replyContent(reply, users, emoji, styles, colors) {
  if (!reply.text) return reply.file ? [<Icon key="clip" name="paperclip" size={12} color={colors.textMuted} />, ' Attachment'] : null;
  // split() with a (group) keeps the tokens' insides at the odd places: "hi <:17>" -> ["hi ", ":17", ""].
  return reply.text.split(/<(:\d+|@\d+|@everyone)>/).map((part, index) => {
    if (index % 2 === 0) return part;
    if (part.startsWith(':')) return <CustomEmoji key={index} item={emoji[part.slice(1)]} size={16} />;
    const name = part === '@everyone' ? 'everyone' : users[part.slice(1)]?.name ?? 'unknown';
    return <Text key={index} style={styles.replyMention}>@{name}</Text>;
  });
}

// The long-press menu, a sheet from the bottom. The same choices, in the same order, as the web
// page's bar on a message: reactions, Reply, Pin, Edit, Delete; and Copy text (a PC's mouse selects it).
// At its top, when it was sent (the web page shows a grouped message's time on hover).
function MessageMenu({ message, canChange, onClose, onReact, onMoreReactions, onReply, onCopy, onPin, onEdit, onDelete }) {
  const styles = useStyles(makeStyles);
  // A Modal covers the whole screen, navigation bar included, so the sheet leaves room for that
  // bar itself: insets.bottom is its height.
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* A Pressable without onPress inside: taps on the sheet itself don't reach the backdrop. */}
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}>
          <Text style={styles.menuTime}>{headerTime(new Date(message.sent_at))}</Text>
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
            {/* The web page's "Add reaction" smiley: every emoji, in the picker. */}
            <Pressable onPress={onMoreReactions} style={({ pressed }) => [styles.quickReaction, pressed && styles.pressed]}>
              <Icon name="smiley" size={30} />
            </Pressable>
          </View>
          <MenuItem icon="reply" label="Reply" onPress={onReply} />
          {message.text ? <MenuItem icon="copy" label="Copy text" onPress={onCopy} /> : null}
          {message.kind === null ? <MenuItem icon="pin" label={message.pinned ? 'Unpin' : 'Pin'} onPress={onPin} /> : null}
          {canChange && message.kind === null ? <MenuItem icon="pencil" label="Edit" onPress={onEdit} /> : null}
          {canChange ? <MenuItem icon="trash-2" label="Delete" onPress={onDelete} danger /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MenuItem({ icon, label, onPress, danger }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
      <Icon name={icon} color={danger ? colors.red : colors.icon} />
      <Text style={[styles.menuText, danger && styles.danger]}>{label}</Text>
    </Pressable>
  );
}

// The + button's sheet: where the files come from. (The web page's + opens the computer's file
// picker; a phone has three places: the photos, the camera, and its files.)
function AttachMenu({ onClose, onPhotos, onCamera, onFiles }) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingTop: 8, paddingBottom: insets.bottom + 8 }]}>
          <MenuItem icon="image" label="Photos and videos" onPress={onPhotos} />
          <MenuItem icon="camera" label="Take a photo" onPress={onCamera} />
          <MenuItem icon="file" label="File" onPress={onFiles} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// The tray above the text box (the web page's #tray): what's about to be sent, each with an ×.
// A picture as a small square, any other file as its name and size; a failed one outlined in red.
function Tray({ items, onRemove }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.tray}>
      {items.map((item) => (
        <View key={item.key} style={[styles.trayItem, !item.image && styles.trayFile, item.failed && styles.trayFailed]}>
          {item.image ? (
            <Image source={{ uri: item.uri }} style={styles.trayImage} />
          ) : (
            <View style={styles.trayFileRow}>
              <Icon name="file" size={14} color={colors.text} />
              <Text numberOfLines={3} style={styles.trayFileName}>{item.name} ({formatSize(item.size)})</Text>
            </View>
          )}
          <Pressable onPress={() => onRemove(item)} hitSlop={6} style={styles.trayRemove}>
            <Icon name="x" size={16} color="#ffffff" />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

// A moment as part of a file name: "2026-10-15-04.51.23" (dots, as Windows allows no ":" in names).
function timeForName(date) {
  const two = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-`
    + `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}

// "20261014_182205" from the moment the camera wrote inside the photo ("2026:10:14 18:22:05"), or null.
function takenName(asset) {
  const taken = asset.exif?.DateTimeOriginal ?? asset.exif?.DateTime;
  const parts = typeof taken === 'string' && taken.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return parts ? `${parts[1]}${parts[2]}${parts[3]}_${parts[4]}${parts[5]}${parts[6]}` : null;
}

// A picked photo's or video's file ending, from its type ("image/jpeg" -> "jpg"), else from its address.
function extension(asset) {
  const fromType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[asset.mimeType];
  return fromType ?? asset.uri.split('.').pop().toLowerCase();
}

// backRef: App.js's; this fills in what the back button should do here first (see below).
// shared: something shared to the app from another one, for the tray and the text box (App.js), or
// null; onSharedTaken: say it's been taken. trays, drafts (and their setters): every chat's tray and
// half-written text (App.js keeps them, so they stay while this screen is away, on the People page).
// onOpenChat(key): open another chat (App.js's go), for a search result there. popup: the top bar's
// popup that's open ("search", "pins", "info" or null), drawn here; setPopup changes it. onProfile(id),
// onUserMenu(id): someone's profile or user menu (App.js draws them). focusTick: a new number puts the
// cursor at the end of the text box (after the user menu's Mention added "@name "). jumpRequest: a
// message to go to, {chat, id} (a tapped notification's), or null; onJumpTaken: say we're on our way.
export default function ChatScreen({
  connection, backRef, shared, onSharedTaken, trays, setTrays, drafts, setDrafts, onOpenChat, popup, setPopup,
  onProfile, onUserMenu, focusTick, jumpRequest, onJumpTaken,
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { current, messages, users, roles, me, lastRead, more, blocked } = connection;
  const [menuFor, setMenuFor] = useState(null);    // the message whose menu is open
  const [replyTo, setReplyTo] = useState(null);    // the message we're replying to
  const [editing, setEditing] = useState(null);    // the message we're editing
  const [cursor, setCursor] = useState(0);         // where the cursor is in the text box
  const [shownBlocked, setShownBlocked] = useState(new Set());  // blocked people's messages we chose to see
  const [picker, setPicker] = useState(null);      // the emoji/GIF picker: null, "insert", or {react: message}
  // The status line's right side: {text, error}, like "Uploading cat.jpg…", or what went wrong; or null.
  const [status, setStatus] = useState(null);
  // The message we're on our way to, {chat, id} (loading older batches until it's there), or null.
  const [jump, setJump] = useState(null);
  const jumpBatches = useRef({ count: 0, waitingFor: null });  // batches asked for, and our oldest id then
  const [flash, setFlash] = useState(null);  // the message that lights up: {id, n}
  const [charNote, setCharNote] = useState(null);  // the counter's warning for now ("No room for that emoji…")
  const list = useRef(null);     // the FlatList, to scroll it
  const rowsNow = useRef([]);    // the rows it was last given (newest first)
  const scrollTries = useRef(0);
  const scrollPosition = useRef(0.5);  // where scrollToIndex puts its row (onScrollToIndexFailed tries again with it)
  // Each chat keeps its own tray and text, like Discord: a picture picked or words typed in a DM stay
  // there when you go elsewhere.
  // Each chat's tray (trays, from App.js): files about to be sent there,
  // {chatKey: [{key, uri, name, type, size, image, failed}]}.
  const tray = trays[current] ?? [];  // the open chat's
  // Change one chat's tray: change gets its list and returns the new one (like setState's function).
  function setTrayOf(chat, change) {
    setTrays((old) => ({ ...old, [chat]: change(old[chat] ?? []) }));
  }
  const setTray = (change) => setTrayOf(current, change);  // the open chat's
  // The same for what's typed in the text box (drafts, from App.js: {chatKey: text}). setDraft takes the
  // new text, or a function from the old text to the new, like a useState setter.
  const draft = drafts[current] ?? '';
  function setDraftOf(chat, text) {
    setDrafts((old) => ({ ...old, [chat]: typeof text === 'function' ? text(old[chat] ?? '') : text }));
  }
  const setDraft = (text) => setDraftOf(current, text);
  // The open chat at this very moment (the variable `current` is the one this drawing was made with;
  // an upload that's still running needs to know whether we've moved on since).
  const currentNow = useRef(current);
  currentNow.current = current;
  const [attachMenu, setAttachMenu] = useState(false);  // the + button's sheet is open
  const [uploading, setUploading] = useState(false);    // the tray is being sent
  // A ref to the text box itself (not its text): input.current.focus() puts the cursor in it.
  const input = useRef(null);
  // What the latest share put here, until it's sent: {keys (its tray items), text}, or null.
  const fromShare = useRef(null);
  // Android's back button: App.js asks this first (backRef). While the emoji panel is open, back
  // closes it. Right after a share, back cancels it: what it added comes out again, and Android goes
  // back to the app we were shared from (exitApp: the default back, which puts our app behind it).
  // (Its own listener wouldn't do: Android asks the newest listener first, and App.js's is
  // registered again now and then, which made it newer.) True: handled.
  useEffect(() => {
    backRef.current = () => {
      if (picker === 'insert') {
        setPicker(null);
        return true;
      }
      if (fromShare.current) {
        const { keys, text } = fromShare.current;
        fromShare.current = null;
        setTray((old) => old.filter((item) => !keys.includes(item.key)));
        if (text) setDraft((old) => old.replace(text, '').trim());
        BackHandler.exitApp();
        return true;
      }
      return false;
    };
    return () => { backRef.current = null; };
  }, [picker]);

  // The smiley: the emoji panel in the keyboard's place (the keyboard closes), or, when it's open,
  // back to the keyboard. Like on Discord and in phones' own keyboards.
  function toggleEmojiPanel() {
    if (picker === 'insert') {
      setPicker(null);
      input.current?.focus();
    } else {
      Keyboard.dismiss();
      setPicker('insert');
    }
  }

  const label = chatLabel(current, connection);
  const isAdmin = users[me.id]?.admin === true;

  // Suggestions while typing (the web page's autocomplete), from the text just before the cursor:
  // ":po" (2+ letters) offers emoji, "@ka" offers people in this chat (and @everyone in a channel):
  // names starting with it first, then names containing it.
  const beforeCursor = draft.slice(0, cursor);
  const typedEmoji = beforeCursor.match(/(^|\s):([A-Za-z0-9_]{2,32})$/);
  const typedMention = beforeCursor.match(/(^|\s)@([A-Za-z0-9_-]{0,32})$/);
  let suggestions = [];
  if (typedEmoji) {
    suggestions = findEmoji(typedEmoji[2], connection);
  } else if (typedMention) {
    const query = typedMention[2].toLowerCase();
    const people = chatPeople(current, connection);
    const named = [
      ...people.filter((user) => user.name.toLowerCase().startsWith(query)),
      ...people.filter((user) => !user.name.toLowerCase().startsWith(query) && user.name.toLowerCase().includes(query)),
    ];
    suggestions = named.map((user) => ({
      key: 'user' + user.id, user, label: user.name, insert: `@${user.name} `,
      // What they wrote about themselves, else their status while they're on (the web page's detail).
      detail: user.status || (user.online ? PRESENCE_NAMES[user.presence] ?? 'online' : ''),
    }));
    // @everyone in DMs and groups too, like the web page's findPeople.
    if ('everyone'.startsWith(query)) {
      suggestions.push({ key: 'everyone', label: 'everyone', insert: '@everyone ', detail: 'Notify everyone who can see this channel' });
    }
    suggestions = suggestions.slice(0, MAX_SUGGESTIONS);
  }

  // Swap the half-typed ":po" or "@ka" before the cursor for the whole thing (":pog: ", "@kari ").
  function pickSuggestion(suggestion) {
    const before = beforeCursor.replace(/[:@][A-Za-z0-9_-]*$/, suggestion.insert);
    setDraft(before + draft.slice(cursor));
    setCursor(before.length);
  }

  // Typing: tell the others ("kari is typing…"), at most every 2 s (connection.js).
  function onType(text) {
    setDraft(text);
    setCharNote(null);
    if (text.trim()) connection.sendTyping();
  }

  // An emoji from the picker goes in at the cursor: a Unicode one as itself, a custom one as
  // ":name:" (the server makes it a picture). Not if the message would get too long.
  function insertEmoji(value) {
    const text = value.startsWith('custom:') ? `:${connection.emoji[value.slice(7)]?.name}:` : value;
    if (draft.length + text.length > me.maxTextLength) {
      setCharNote('No room for that emoji: character limit reached');
      return;
    }
    const before = draft.slice(0, cursor) + text;
    setDraft(before + draft.slice(cursor));
    setCursor(before.length);
  }

  // A GIF: the server fetches it from GIPHY and keeps it as an upload (/gifs/send), then it goes
  // out as a message with that file, a reply if we were replying (the web page's sendGif).
  async function sendGif(gif) {
    setPicker(null);
    setStatus({ text: 'Sending GIF…' });
    try {
      const response = await fetch(`${SERVER}/gifs/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: gif.id }),
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(typeof answer.detail === 'string' ? answer.detail : "Couldn't send the GIF.");
        return;
      }
      connection.sendMessage('', replyTo?.id, answer.id);
      toBottom();
      setReplyTo(null);
      setStatus(null);
    } catch {
      showError('Not connected, try again in a moment.');
    }
  }

  // Something went wrong: in red on the status line, gone after 5 s (the web page's showUploadError).
  // Sending while scrolled up: back down to the newest, where it appears (the list is upside down: 0 is the bottom).
  function toBottom() {
    list.current?.scrollToOffset({ offset: 0, animated: true });
  }

  function showError(text) {
    setStatus({ text, error: true });
    setTimeout(() => setStatus((now) => (now?.text === text ? null : now)), 5000);
  }

  // ----- Going to a message (the web page's jumpToMessage and openMessage)
  //
  // From a pin, a search result or a reply's quote. Another chat opens first, and its history comes.
  // A message older than everything loaded: older batches load until it's there (each batch changes
  // `messages`, which runs the effect below again). Then the list scrolls to it and it lights up.

  function jumpTo(chat, id) {
    setPopup(null);
    jumpBatches.current = { count: 0, waitingFor: null };
    if (chat !== current) onOpenChat(chat);
    setJump({ chat, id });
  }

  // A tapped notification's message (App.js has opened its chat already).
  useEffect(() => {
    if (!jumpRequest) return;
    jumpTo(jumpRequest.chat, jumpRequest.id);
    onJumpTaken();
  }, [jumpRequest]);

  useEffect(() => {
    if (!jump || jump.chat !== current || messages === null) return;  // (the chat's history isn't here yet)
    const index = rowsNow.current.findIndex((row) => row.message?.id === jump.id);
    if (index !== -1) {
      setJump(null);
      setStatus((now) => (now?.finding ? null : now));
      scrollTries.current = 0;
      // viewPosition 0.5: in the middle of the screen.
      scrollPosition.current = 0.5;
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      setFlash({ id: jump.id, n: Date.now() });
      return;
    }
    // Not loaded. Older than everything we have (ids only grow): load older ones, if there are any.
    // Otherwise (between loaded ones, or nothing older left) it was deleted.
    const oldest = messages[0]?.id;
    const batches = jumpBatches.current;
    if (oldest !== undefined && jump.id < oldest && more && batches.count < MAX_JUMP_BATCHES) {
      if (batches.waitingFor === oldest) return;  // asked already; that batch hasn't come yet
      batches.count += 1;
      batches.waitingFor = oldest;
      setStatus({ text: 'Finding the message…', finding: true });
      connection.loadOlder();
      return;
    }
    setJump(null);
    setStatus((now) => (now?.finding ? null : now));
    showError(batches.count >= MAX_JUMP_BATCHES ? 'That message is very far up: scroll up to find it.'
      : 'That message has been deleted.');
  }, [jump, messages, current]);

  // scrollToIndex only knows where rows are that have been drawn, and FlatList only draws the rows
  // near the screen (that's what keeps a long list fast). For one further away it calls this
  // instead: scroll to a guess (its number times the rows' average height), which draws the rows
  // there, then try again a moment later. A few times at most.
  function onScrollToIndexFailed(info) {
    if (scrollTries.current >= 10) return;
    scrollTries.current += 1;
    list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: scrollPosition.current, animated: true }), 100);
  }

  // The NEW line: once a chat's history is here, if the line is above what's on screen (more new
  // messages than fit), scroll so it's at the top, to start reading where we left off (the web page's
  // scrollToNewDivider). Judged once, when FlatList first says which rows are in view. (A ref as the
  // callback: FlatList doesn't allow it to change. Set while drawing: before FlatList can call it.)
  const checkNewLine = useRef(false);
  const hadMessages = useRef(false);
  if (messages !== null && !hadMessages.current && lastRead !== null && !jump && !jumpRequest) checkNewLine.current = true;
  hadMessages.current = messages !== null;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (!checkNewLine.current) return;
    checkNewLine.current = false;
    if (viewableItems.some((viewable) => viewable.item.type === 'new')) return;  // in view already
    const index = rowsNow.current.findIndex((row) => row.type === 'new');
    if (index === -1) return;
    scrollTries.current = 0;
    scrollPosition.current = 1;  // (the list is upside down: 1 is the top of the screen)
    list.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
  }).current;

  // Mention (the user menu): App.js has added "@name " to our text; the cursor goes after it.
  useEffect(() => {
    if (focusTick === 0) return;  // (not when the screen first appears)
    setCursor(draft.length);
    focusTextBox(350);
  }, [focusTick]);

  // The chat already has 100 pinned messages (the server said "pins_full").
  useEffect(() => {
    if (connection.pinsFull) showError(`This chat already has ${connection.pinsFull.max} pinned messages: unpin one first.`);
  }, [connection.pinsFull]);

  // ----- Files: picking them (the + sheet), the tray, sending them.

  // Files picked: into the tray, if they're not too big and there's room (the web page's addToTray).
  // Each: {uri, name, type, size}.
  function addToTray(files) {
    const room = MAX_TRAY_FILES - tray.length;
    const fitting = files.filter((file) => file.size > 0 && file.size <= limits.upload_size);
    const empty = files.find((file) => file.size === 0);
    if (empty) showError(`${empty.name} is empty`);  // (nothing to send: the server refuses those too)
    else if (fitting.length < files.length) showError(`Files can be at most ${megabytes(limits.upload_size)}`);
    else if (fitting.length > room) showError(`At most ${MAX_TRAY_FILES} files at a time`);
    const added = fitting.slice(0, room).map((file) => ({
      ...file,
      key: `${Date.now()}-${Math.random()}`,  // only for React's list
      image: limits.image_types.includes(file.type),  // (the ones the server shows as pictures)
      failed: false,
    }));
    setTray((old) => [...old, ...added]);
    return added.map((item) => item.key);
  }

  // Something shared to the app (modules/shared-files). The text goes into the text box (after what's
  // there already), the files into the tray: each copied into our own storage first, while we may still
  // read it. Only the ones the tray will take are copied; the rest still go to addToTray, which leaves
  // them out and says why (too big, too many).
  // Another chat: back is ordinary back again. (Before the effect below: on the screen's first
  // draw, effects run in order, so a share that comes with it isn't forgotten straight away.)
  // (And the cursor goes to the end of that chat's own text.)
  useEffect(() => {
    fromShare.current = null;
    setCursor(draft.length);
    setJump((now) => (now?.chat === current ? now : null));  // (on the way to a message in the chat we left: forget it)
  }, [current]);
  useEffect(() => {
    if (!shared) return;
    onSharedTaken();
    const added = { keys: [], text: shared.text };
    fromShare.current = added;
    if (shared.text) {
      setDraft((old) => (old.trim() ? `${old} ${shared.text}` : shared.text).slice(0, me.maxTextLength));
    }
    if (shared.files.length > 0) takeSharedFiles(shared.files).then((keys) => { added.keys = keys; });
  }, [shared]);

  // Returns the new tray items' keys.
  async function takeSharedFiles(files) {
    let room = MAX_TRAY_FILES - tray.length;
    const ready = [];
    for (const file of files) {
      if (file.size > limits.upload_size || room === 0) {
        ready.push(file);
        continue;
      }
      try {
        const copy = await copySharedFile(file.uri, file.name);
        ready.push({ ...file, uri: copy.uri, size: copy.size });  // size: now known for certain
        room -= 1;
      } catch {
        showError(`Couldn't read ${file.name}`);
      }
    }
    return addToTray(ready);
  }

  // Android's photo picker (several at once). Needs no permission: the picker is Android's own,
  // and only what's picked reaches the app.
  async function pickPhotos() {
    setAttachMenu(false);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_TRAY_FILES - tray.length,
      exif: true,  // what the camera wrote inside each photo: the moment it was taken, for its name
    });
    if (!result.canceled) addToTray(fromPicker(result.assets));
  }

  // The camera. Android asks for permission the first time.
  async function takePhoto() {
    setAttachMenu(false);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      showError('The app may not use the camera (Android settings → Apps → ChatApp)');
      return;
    }
    // quality 0.8: a JPEG a few MB big rather than the camera's full size.
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, exif: true });
    if (!result.canceled) addToTray(fromPicker(result.assets));
  }

  // Android's file picker, for any kind of file. expo-document-picker asks Android for each file's
  // real name ("report.pdf"): the file's address only has a number in it (content://…/document:1000006562).
  // copyToCacheDirectory: a copy in our own storage, so it can still be read when we upload it.
  async function pickFiles() {
    setAttachMenu(false);
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled) {
      addToTray(result.assets.map((file) => ({
        uri: file.uri,
        name: file.name,
        type: file.mimeType,
        size: file.size ?? new File(file.uri).size,
      })));
    }
  }

  // The photo picker's and camera's answers say the same things in other words. Neither has the
  // photo's real name: Android's picker only gives its number ("1000009517.jpg"; the name stays private
  // without access to the whole gallery), a new photo a random one. So each is named after when it was
  // taken, read from inside the photo (EXIF), the way Samsung's camera names them: "20261014_182205.jpg".
  // A picture without that date (a screenshot, a video) is named after now: "photo-2026-10-15-04.51.23.jpg".
  // Two the same get _1, _2, … .
  function fromPicker(assets) {
    const used = new Set();
    return assets.map((asset) => {
      const base = takenName(asset)
        ?? `${asset.type === 'video' ? 'video' : 'photo'}-${timeForName(new Date())}`;
      let name = `${base}.${extension(asset)}`;
      for (let count = 1; used.has(name); count++) name = `${base}_${count}.${extension(asset)}`;
      used.add(name);
      return {
        uri: asset.uri,
        name,
        type: asset.mimeType,
        size: asset.fileSize ?? new File(asset.uri).size,
      };
    });
  }

  // Send pressed with files in the tray: upload and send each one as its own message, the text
  // going with the first one (and the reply). One that fails stays in the tray, in red (sendTray).
  async function sendTray(caption) {
    setUploading(true);
    toBottom();
    const chat = current;  // a message goes to the open chat, so we stop if that changes
    let reply = replyTo?.id;
    for (const item of tray) {
      setStatus({ text: `Uploading ${item.name}…` });
      let sent = false;
      try {
        const id = await uploadFile(item);
        if (currentNow.current !== chat) break;  // moved to another chat: the rest wait in their tray
        sent = connection.sendMessage(caption, reply, id);
        if (!sent) showError('Not connected, try again in a moment');
      } catch (error) {
        showError(error.message);
      }
      if (!sent) {
        setTrayOf(chat, (old) => old.map((other) => (other.key === item.key ? { ...other, failed: true } : other)));
        continue;
      }
      setTrayOf(chat, (old) => old.filter((other) => other.key !== item.key));
      if (caption) {
        caption = '';  // used up by this file
        setDraftOf(chat, '');
      }
      reply = null;
      setReplyTo(null);
    }
    setStatus((now) => (now?.error ? now : null));  // (a failure's message stays its 5 s)
    setUploading(false);
  }

  function send() {
    fromShare.current = null;  // sent: back is ordinary back again
    const text = draft.trim();
    if (tray.length > 0 && !editing) {
      if (!uploading) sendTray(text);
      return;
    }
    if (editing) {
      const message = editing;
      setEditing(null);
      setDraft('');
      if (text === readableText(message.text, users, connection.emoji).trim()) return;  // nothing changed
      if (!text && !message.file) {
        // Emptied completely: that's really a delete (like on the web page and Discord), asked first.
        Alert.alert('Delete message?', "This can't be undone.", [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => connection.deleteMessage(message.id) },
        ]);
        return;
      }
      connection.editMessage(message.id, text);  // (a file's caption may be emptied: the file stays)
      return;
    }
    if (!text) return;
    connection.sendMessage(text, replyTo?.id);
    toBottom();
    setReplyTo(null);
    setDraft('');
  }

  function react(messageId, reaction) {
    connection.react(messageId, reaction);
    setMenuFor(null);
  }

  // Ready to type after Reply or Edit. A moment later: the menu's popup is still closing, and
  // Android won't open the keyboard for a box behind it.
  // (delay: the user menu's Mention waits longer, for its whole popup to fade out first.)
  function focusTextBox(delay = 100) {
    setTimeout(() => input.current?.focus(), delay);
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

  // Copy text (the long-press menu): as typed, "@kari" and ":pog:", not the stored "<@2>".
  function copyText() {
    Clipboard.setStringAsync(readableText(menuFor.text, users, connection.emoji));  // (Android says "Copied")
    setMenuFor(null);
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
    if (item.type === 'pending') return <PendingMessage item={item.item} connection={connection} />;
    return (
      <Message
        message={item.message} grouped={item.grouped} connection={connection}
        isBlocked={blocked.includes(item.message.user_id) && !shownBlocked.has(item.message.id)}
        flash={flash?.id === item.message.id ? flash.n : null}
        onShow={(id) => setShownBlocked((old) => new Set(old).add(id))}
        onLongPress={setMenuFor}
        onJump={(id) => jumpTo(current, id)}
        onProfile={onProfile}
        onUserMenu={onUserMenu}
      />
    );
  }

  let body;
  if (messages === null) {
    body = <ActivityIndicator style={styles.middle} color={colors.textMuted} size="large" />;
  } else {
    const rows = buildRows(messages, lastRead, blocked);
    if (!more) rows.unshift({ key: 'start', type: 'start' });  // nothing older: the chat's beginning
    // Then ours still on their way (the outbox), below everything.
    for (const item of connection.outbox) {
      if (item.chat === current) rows.push({ key: 'out' + item.nonce, type: 'pending', item });
    }
    // inverted: the list is drawn upside down, so it starts at the bottom like a chat, and a new
    // message appears at the bottom without scrolling. So it gets the rows newest first, and its
    // "end" is the top: getting near it (onEndReached) asks for older messages.
    rows.reverse();
    rowsNow.current = rows;  // (for jumping: which row a message is)
    body = (
      <FlatList
        ref={list}
        inverted
        data={rows}
        extraData={flash}  // (draw the rows again when a message should light up)
        onScrollToIndexFailed={onScrollToIndexFailed}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        contentContainerStyle={styles.listInside}
        keyboardShouldPersistTaps="handled"  // a tap on a chip works even while the keyboard is up
        onEndReached={connection.loadOlder}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={onViewableItemsChanged}
      />
    );
  }

  const replyName = replyTo && (users[replyTo.user_id]?.name ?? replyTo.name);

  // The character counter (the web page's updateCharCount): "1850 / 2000" near the limit, a red warning at it.
  // (.length counts many emoji as 2 where the server counts 1: the limit comes a little early, never late.)
  const max = me.maxTextLength;
  let counter = null;
  if (charNote) counter = { text: charNote, limit: true };
  else if (draft.length >= max) counter = { text: `Character limit reached (${max})`, limit: true };
  else if (draft.length >= max - COUNT_FROM) counter = { text: `${draft.length} / ${max}`, limit: false };

  // "kari is typing…", "kari and ola are typing…", "Several people are typing…" (the web page's words).
  const { typing } = connection;
  let typingText = '';
  if (typing.length === 1) typingText = `${typing[0]} is typing…`;
  else if (typing.length === 2) typingText = `${typing[0]} and ${typing[1]} are typing…`;
  else if (typing.length > 2) typingText = 'Several people are typing…';

  return (
    // (Room for the keyboard is made around the whole screen, in App.js.)
    <View style={styles.screen}>
      {body}

      {/* The web page's #status-line, always there (so nothing jumps): who's typing on the left,
          a file or GIF on its way (or what went wrong) on the right. */}
      <View style={styles.statusLine}>
        <Text numberOfLines={1} style={styles.statusText}>{typingText}</Text>
        {status ? <Text style={[styles.statusText, status.error && styles.statusError]}>{status.text}</Text>
          : counter ? <Text style={[styles.statusText, counter.limit && styles.statusError]}>{counter.text}</Text> : null}
      </View>

      {suggestions.length > 0 ? (
        // The web page's #autocomplete: a box just above the text box, a row per suggestion.
        <View style={styles.autocomplete}>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.key}
              onPress={() => pickSuggestion(suggestion)}
              style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
            >
              {suggestion.user ? <Avatar user={suggestion.user} size={24} /> : null}
              {suggestion.custom ? <CustomEmoji item={suggestion.custom} size={24} /> : null}
              {suggestion.character ? <Text style={styles.suggestionEmoji}>{suggestion.character}</Text> : null}
              {suggestion.key === 'everyone' ? <Icon name="megaphone" size={22} color={colors.icon} /> : null}
              <Text
                numberOfLines={1}
                style={[styles.suggestionName, { color: (suggestion.user && nameColor(suggestion.user, roles)) ?? colors.text }]}
              >
                {suggestion.label}
              </Text>
              {suggestion.detail ? <Text numberOfLines={1} style={styles.suggestionDetail}>{suggestion.detail}</Text> : null}
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
      {tray.length > 0 && !editing ? (
        <Tray items={tray} onRemove={(item) => !uploading && setTray((old) => old.filter((other) => other !== item))} />
      ) : null}
      <View style={styles.form}>
        {/* The web page's + (not while editing: an edit can't add a file). */}
        {editing ? null : (
          <Pressable onPress={() => setAttachMenu(true)} style={({ pressed }) => [styles.smiley, pressed && styles.sendPressed]}>
            <Icon name="plus" size={24} />
          </Pressable>
        )}
        <TextInput
          ref={input}
          style={styles.input}
          value={draft}
          onChangeText={onType}
          onSelectionChange={(event) => setCursor(event.nativeEvent.selection.end)}  // for the suggestions
          onFocus={() => picker === 'insert' && setPicker(null)}  // the keyboard comes: the emoji panel goes
          placeholder={`Message ${label}`}
          placeholderTextColor={colors.textMuted}
          multiline                          // grows with the text, up to maxHeight
          maxLength={me.maxTextLength}       // the server's limit (from "welcome")
        />
        {/* The smiley: on a phone one button for both emoji and GIFs (the picker's tabs). */}
        <Pressable onPress={toggleEmojiPanel} style={({ pressed }) => [styles.smiley, pressed && styles.sendPressed]}>
          <Icon name="smiley" size={24} />
        </Pressable>
        <Pressable
          onPress={send}
          disabled={!draft.trim() && !editing && tray.length === 0}  // (an edit emptied: a delete, or a cleared caption)
          style={({ pressed }) => [styles.send, pressed && styles.sendPressed]}
        >
          <Text style={styles.sendText}>{editing ? 'Save' : 'Send'}</Text>
        </Pressable>
      </View>

      {/* Writing: the emoji/GIF panel under the text box, where the keyboard would be. */}
      {picker === 'insert' ? (
        <Picker
          connection={connection}
          mode="insert"
          inline
          onPickEmoji={insertEmoji}  // (the panel stays open for more, like the web page's)
          onPickGif={sendGif}
          onClose={() => setPicker(null)}
        />
      ) : null}

      {attachMenu ? (
        <AttachMenu onClose={() => setAttachMenu(false)} onPhotos={pickPhotos} onCamera={takePhoto} onFiles={pickFiles} />
      ) : null}

      {menuFor ? (
        <MessageMenu
          message={menuFor}
          canChange={menuFor.user_id === me.id || isAdmin}  // the server's rule too
          onClose={() => setMenuFor(null)}
          onReact={react}
          onMoreReactions={() => {
            setPicker({ react: menuFor });
            setMenuFor(null);
          }}
          onReply={startReply}
          onCopy={copyText}
          onPin={togglePin}
          onEdit={startEdit}
          onDelete={confirmDelete}
        />
      ) : null}

      {popup === 'pins' ? (
        <PinsScreen connection={connection} onJump={(id) => jumpTo(current, id)} onClose={() => setPopup(null)} onUserMenu={onUserMenu} />
      ) : null}
      {popup === 'search' ? <SearchScreen connection={connection} onJump={jumpTo} onClose={() => setPopup(null)} onUserMenu={onUserMenu} /> : null}
      {/* A DM's or group's name in the top bar: its members, media, pins, links and files. */}
      {popup === 'info' ? (
        <ChatInfoScreen
          connection={connection} chatKey={current} onJump={(id) => jumpTo(current, id)} onClose={() => setPopup(null)}
          onProfile={onProfile} onUserMenu={onUserMenu}
        />
      ) : null}

      {/* A reaction (from a message's long-press menu): every emoji, in a popup sheet. */}
      {picker?.react ? (
        <Picker
          connection={connection}
          mode="react"
          onPickEmoji={(value) => {
            connection.react(picker.react.id, value);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </View>
  );
}

// The web page's sizes (chat.css), with its rem as 16 px: 0.75rem = 12, 0.85rem = 13.6, and so on.
const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  // The light behind a message we jumped to: the accent at 35%, over the whole message.
  flash: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.accent35 },
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
  pictureTouch: { alignSelf: 'flex-start' },  // (only the picture itself, not the row's whole height)
  body: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  name: { fontSize: size(16), fontWeight: '600' },
  time: { fontSize: size(12), color: colors.textMuted },
  note: { color: colors.textMuted, fontStyle: 'italic' },
  blockedRow: { alignItems: 'center', gap: 8, marginTop: 8 },
  // A message on its way (PendingMessage): faded; failed: red words, Retry and Delete as links.
  sending: { opacity: 0.5 },
  pendingNote: { fontSize: size(12), color: colors.textMuted },
  pendingFailed: { fontSize: size(13), color: colors.red },
  pendingAction: { color: colors.link, fontWeight: '600' },
  blocked: { flex: 1, color: colors.textMuted, fontSize: size(14) },
  show: { color: colors.link },
  // .reply-line: 0.8rem, muted, the name bold in --text-soft.
  replyLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  replyName: { fontSize: size(12.8), fontWeight: '700', color: colors.textSoft },
  replyText: { flex: 1, fontSize: size(12.8), color: colors.textMuted },
  replyMention: { backgroundColor: colors.accent30, color: colors.mentionText },  // (MessageText's .mention)
  // .reactions and .reaction-chip.
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: 'transparent',
    backgroundColor: colors.bgPanel,
  },
  chipMine: { borderColor: colors.accent, backgroundColor: colors.accent15 },
  chipText: { fontSize: size(13.6), color: colors.text },
  // .date-divider: "──── Today ────".
  dateDivider: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 4 },
  dateLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dateText: { fontSize: size(12), fontWeight: '600', color: colors.textMuted },
  // .new-divider: a red line ending in a red NEW tag.
  newDivider: { flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 4 },
  newLine: { flex: 1, height: 1, backgroundColor: colors.red },
  newTag: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
    backgroundColor: colors.red, color: '#ffffff', fontSize: size(10.4), fontWeight: '700',
  },
  channelStart: { marginTop: 8, marginBottom: 16, fontSize: size(13.6), color: colors.textMuted },
  // The long-press sheet.
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  sheet: { backgroundColor: colors.bgPanel, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  quickReactions: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12 },
  quickReaction: { padding: 8, borderRadius: 24 },
  quickReactionText: { fontSize: size(28) },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  menuTime: { textAlign: 'center', fontSize: size(12), color: colors.textMuted, marginBottom: 4 },
  menuText: { color: colors.text, fontSize: size(16) },
  danger: { color: colors.red },
  // #autocomplete.
  autocomplete: {
    marginHorizontal: 8, padding: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
    backgroundColor: colors.bgPanel,
  },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  suggestionPressed: { backgroundColor: colors.bgHover },
  suggestionName: { flexShrink: 1, fontSize: size(15.2) },
  suggestionEmoji: { width: 24, textAlign: 'center', fontSize: size(20.8) },
  suggestionDetail: { flexShrink: 1, marginLeft: 'auto', fontSize: size(12.8), color: colors.textMuted },  // pushed to the right
  // #status-line: always 1.2 lines tall, typing on the left, sending on the right.
  statusLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, height: 17, paddingHorizontal: 16 },
  statusText: { flexShrink: 1, fontSize: size(13.6), lineHeight: size(17), color: colors.textMuted },
  statusError: { color: colors.red },
  // The + and the smiley: like the web page's "+" and smiley buttons, on the message box's colour.
  smiley: { backgroundColor: colors.bgInput, borderRadius: 8, padding: 10 },
  // #tray on a phone: 80px squares (a file 160px wide), wrapping; the × in a red circle, 28px.
  tray: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8, paddingHorizontal: 16 },
  trayItem: { width: 80, height: 80, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.bgPanel },
  trayFile: { width: 160, padding: 8, paddingRight: 34 },
  trayFailed: { borderWidth: 2, borderColor: colors.red },
  trayImage: { width: '100%', height: '100%' },
  trayFileRow: { flexDirection: 'row', gap: 4 },
  trayFileName: { flexShrink: 1, fontSize: size(12.8), color: colors.text },
  trayRemove: {
    position: 'absolute', top: 4, right: 4, width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.red,
  },
  // #reply-bar.
  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8, paddingHorizontal: 12,
    paddingVertical: 6, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: colors.bgPanel,
  },
  replyBarText: { flex: 1, fontSize: size(13.6), color: colors.textSoft },
  replyBarName: { color: colors.textStrong, fontWeight: '700' },
  // #chat-form on a phone: gap 6px, padding 8px; the box and Send as on the web page.
  form: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, padding: 8 },
  input: {
    flex: 1, maxHeight: 200, backgroundColor: colors.bgInput, color: colors.text, fontSize: size(16),
    lineHeight: size(22), borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
  },
  send: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11 },
  sendPressed: { opacity: 0.8 },
  sendText: { color: '#ffffff', fontSize: size(16) },
});
