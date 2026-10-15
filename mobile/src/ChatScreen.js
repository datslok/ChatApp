// One chat's messages, live. Read-only for now: writing comes in the next step.
import { useEffect } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './colors';
import { chatTitle } from './ChannelsScreen';

// Messages store mentions and custom emoji by id ("<@3>", "<@everyone>", "<:17>"), so renames
// show the new name. Turn them back into words: "@kari", ":pog:" (the pictures come later).
function readableText(text, users, emoji) {
  return text
    .replace(/<@(\d+)>/g, (whole, id) => '@' + (users[id]?.name ?? 'someone'))
    .replace(/<@everyone>/g, '@everyone')
    .replace(/<:(\d+)>/g, (whole, id) => (emoji[id] ? `:${emoji[id]}:` : ':?:'));
}

// "14:05" for today, "12.10 14:05" for an older message.
function when(isoTime) {
  const time = new Date(isoTime);
  const two = (n) => String(n).padStart(2, '0');
  const clock = `${two(time.getHours())}:${two(time.getMinutes())}`;
  if (time.toDateString() === new Date().toDateString()) return clock;
  return `${time.getDate()}.${time.getMonth() + 1} ${clock}`;
}

function Message({ message, users, emoji }) {
  const name = (message.user_id && users[message.user_id]?.name) || message.name;
  const text = readableText(message.text, users, emoji);
  const note = message.kind !== null;  // the server's own notes: "📞 started a call", "📌 pinned..."
  return (
    <View style={styles.message}>
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
    </View>
  );
}

export default function ChatScreen({ connection }) {
  const { current, messages, users, emoji, closeChat, status } = connection;

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

  let body;
  if (messages === null) {
    body = <ActivityIndicator style={styles.middle} color={colors.textMuted} size="large" />;
  } else if (messages.length === 0) {
    body = <Text style={[styles.middle, styles.empty]}>No messages yet.</Text>;
  } else {
    // inverted: the list is drawn upside down, so it starts at the bottom like a chat, and a new
    // message appears at the bottom without scrolling. So it gets the messages newest first.
    body = (
      <FlatList
        inverted
        data={[...messages].reverse()}
        keyExtractor={(message) => String(message.id)}
        renderItem={({ item }) => <Message message={item} users={users} emoji={emoji} />}
        contentContainerStyle={styles.listInside}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={closeChat} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{chatTitle(current, connection)}</Text>
      </View>
      {status !== 'online' ? <Text style={styles.offline}>Reconnecting…</Text> : null}
      {body}
    </View>
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
  reply: { color: colors.textMuted, fontSize: 13, marginBottom: 2 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { color: colors.textStrong, fontSize: 15, fontWeight: 'bold' },
  time: { color: colors.textMuted, fontSize: 12, fontWeight: 'normal' },
  text: { color: colors.text, fontSize: 15, marginTop: 2 },
  note: { color: colors.textMuted, fontStyle: 'italic' },
  file: { color: colors.textSoft, fontSize: 14, marginTop: 4 },
});
