// The list of chats: the server's channels (under their headings), then direct messages: our
// groups first, then a DM with each friend (like the web page's sidebar).
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './colors';
import StatusDot from './StatusDot';

// A DM's key is "dm:" + the two user ids, the smaller first (the server's rule): "dm:3:7".
export function dmKey(myId, theirId) {
  return `dm:${Math.min(myId, theirId)}:${Math.max(myId, theirId)}`;
}

// A group's name, or (without one) its other members' names, like the web page.
export function groupName(group, users, myId) {
  if (group.name) return group.name;
  return group.members.filter((id) => id !== myId).map((id) => users[id]?.name ?? '?').join(', ');
}

// What a chat is called at the top of its screen: "# memes", "kari", "kari, ola".
export function chatTitle(key, connection) {
  const { channels, groups, users, me } = connection;
  if (key.startsWith('dm:')) {
    const otherId = key.slice(3).split(':').map(Number).find((id) => id !== me?.id);
    return users[otherId]?.name ?? 'Direct message';
  }
  const group = groups.find((g) => g.key === key);
  if (group) return groupName(group, users, me?.id);
  return '# ' + (channels.find((c) => c.key === key)?.name ?? key);
}

export default function ChannelsScreen({ connection }) {
  const { channels, groups, friends, users, me, unread, mentions, openChat } = connection;

  // One flat list of rows, each either a heading or a chat. FlatList needs a unique `key` per row.
  const rows = [];
  for (const channel of channels) {
    if (channel.heading) rows.push({ key: channel.key, heading: channel.name });
    else rows.push({ key: channel.key, name: '# ' + channel.name });
  }
  rows.push({ key: 'heading:dms', heading: 'Direct messages' });
  for (const group of groups) {
    rows.push({ key: group.key, name: groupName(group, users, me?.id) });
  }
  const dms = friends
    .filter((id) => users[id])  // (someone not in the users list yet: skip until they are)
    .map((id) => ({ key: dmKey(me?.id, id), name: users[id].name, person: users[id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  rows.push(...dms);

  // renderItem draws one row. FlatList only draws the rows on screen (and a few around them),
  // so a long list stays fast.
  function renderRow({ item }) {
    if (item.heading) {
      return <Text style={styles.heading}>{item.heading}</Text>;
    }
    const isUnread = unread.has(item.key);
    const count = mentions[item.key] || 0;
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => openChat(item.key)}
      >
        {item.person ? <StatusDot user={item.person} /> : null}
        <Text style={[styles.name, isUnread && styles.nameUnread]} numberOfLines={1}>
          {item.name}
        </Text>
        {count > 0 ? (
          <View style={styles.badge}><Text style={styles.badgeText}>{count}</Text></View>
        ) : isUnread ? (
          <View style={styles.dot} />
        ) : null}
      </Pressable>
    );
  }

  return <FlatList style={styles.list} data={rows} renderItem={renderRow} />;
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bgPanel },
  heading: {
    color: colors.textMuted, fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase',
    paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6,
  },
  // flexDirection 'row': the name and the dot side by side (a View is a column by default).
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  rowPressed: { backgroundColor: colors.bgActive },
  name: { flex: 1, color: colors.textMuted, fontSize: 16 },
  nameUnread: { color: colors.textStrong, fontWeight: 'bold' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textStrong },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.red, justifyContent: 'center', alignItems: 'center' },
  badgeText: { color: colors.textStrong, fontSize: 12, fontWeight: 'bold' },
});
