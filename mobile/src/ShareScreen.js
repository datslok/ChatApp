// "Share to…": what you see after sharing something to the app from another one (the gallery's
// Share, a link in Chrome). Which chat should it go to? The sidebar's chats in the sidebar's order
// (channels under their headings, then groups and DMs), with a search box on top, like Discord's.
// Tapping one opens it with the files in its tray and the text in the text box (App.js, ChatScreen).
// The web page has nothing like it: sharing into a browser tab isn't a thing.
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Icon from './Icon';
import { useStyles, useTheme } from './theme';
import { dmKey, groupName } from './chats';
import { GroupPicture, Person } from './people';

// share: {files, text} (modules/shared-files). onPick(key): a chat was chosen; onCancel: the ×.
export default function ShareScreen({ connection, share, onPick, onCancel }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { channels, groups, friends, users, roles, me, myPresence } = connection;
  const [query, setQuery] = useState('');

  // Every chat as a row: {key, name (what the search looks in), heading (a heading, not a chat)}.
  const dms = friends.map((id) => users[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const all = [
    ...channels.map((channel) => ({ key: channel.key, name: channel.name, heading: !!channel.heading })),
    { key: 'dm-heading', name: 'Direct messages', heading: true },
    ...groups.map((group) => ({ key: group.key, name: groupName(group, users, me.id), group: true })),
    ...dms.map((user) => ({ key: dmKey(me.id, user.id), name: user.name, user })),
  ];
  // While searching: only the chats whose names contain the words, without headings.
  const words = query.trim().toLowerCase();
  const rows = words ? all.filter((row) => !row.heading && row.name.toLowerCase().includes(words)) : all;

  function renderRow({ item }) {
    if (item.heading) return <Text style={styles.heading}>{item.name}</Text>;
    return (
      <Pressable onPress={() => onPick(item.key)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        {item.user ? (
          <Person user={item.user} roles={roles} me={me} myPresence={myPresence} color={colors.text} ring={colors.bgMain} />
        ) : item.group ? (
          <View style={styles.person}>
            <GroupPicture />
            <Text numberOfLines={1} style={styles.rowText}>{item.name}</Text>
          </View>
        ) : (
          <Text numberOfLines={1} style={styles.rowText}># {item.name}</Text>
        )}
      </Pressable>
    );
  }

  // What's being shared, in a line: "IMG_1234.jpg", "3 files", and/or the text.
  const { files, text } = share;
  const what = files.length === 1 ? files[0].name : files.length > 1 ? `${files.length} files` : null;

  return (
    <View style={styles.screen}>
      {/* Like App.js's top bar: × on the left instead of the menu. */}
      <View style={styles.topbar}>
        <Pressable onPress={onCancel} style={styles.topbarButton} hitSlop={4}>
          <Icon name="x" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Share to…</Text>
      </View>
      <View style={styles.inside}>
        {what ? <Text numberOfLines={1} style={styles.what}>{what}</Text> : null}
        {text ? <Text numberOfLines={2} style={styles.what}>{text}</Text> : null}
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <FlatList
          data={rows}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"  // one tap picks a chat, even with the keyboard open
          ListEmptyComponent={<Text style={styles.empty}>No chats with that name.</Text>}
        />
      </View>
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  topbar: {
    flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  topbarButton: { paddingHorizontal: 12, paddingVertical: 8, minWidth: 46 },
  title: { flex: 1, fontSize: size(16), fontWeight: '600', color: colors.textStrong },
  inside: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  what: { fontSize: size(13.6), color: colors.textMuted, marginBottom: 4 },
  // The People page's search box.
  search: {
    marginTop: 8, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
    backgroundColor: colors.bgDarkest, color: colors.text, fontSize: size(16),
  },
  // The sidebar's headings and rows.
  heading: {
    color: colors.textMuted, fontSize: size(12), fontWeight: '600', textTransform: 'uppercase',
    marginTop: 16, marginBottom: 8, paddingHorizontal: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 6 },
  pressed: { backgroundColor: colors.bgHover },
  rowText: { flex: 1, color: colors.text, fontSize: size(16) },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  empty: { marginVertical: 4, marginHorizontal: 12, fontSize: size(13.6), color: colors.textMuted },
});
