// The bar at the top of every chat (the web page's #dm-header): the chat's name (a group's members
// under it), and at the right the bell (mute), search and the pinned messages. The call button and
// a group's buttons come with their own steps.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { chatLabel, dmPartner } from './chats';
import { colors } from './colors';

function HeaderIcon({ icon, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.icon, pressed && styles.iconPressed]}
    >
      {({ pressed }) => <Icon name={icon} size={20} color={pressed ? colors.iconStrong : colors.icon} />}
    </Pressable>
  );
}

export default function ChatHeader({ connection, onSearch, onPins }) {
  const { current, groups, users, me, mutedChats } = connection;
  const group = groups.find((g) => g.key === current);
  // "you, kari, ola"
  const members = group?.members.map((id) => (id === me.id ? 'you' : users[id]?.name ?? 'someone')).join(', ');
  // The bell mutes this chat, the crossed-out bell unmutes it. Not in a DM with an admin: admins
  // can't be muted (the server's can_mute).
  const muted = mutedChats.has(current);
  const showBell = muted || users[dmPartner(current, me.id)]?.admin !== true;

  return (
    <View style={styles.header}>
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>{chatLabel(current, connection)}</Text>
        {group ? <Text style={styles.members} numberOfLines={1}>{members}</Text> : null}
      </View>
      {showBell ? (
        <HeaderIcon
          icon={muted ? 'bell-off' : 'bell'}
          label={muted ? 'Unmute this chat' : 'Mute this chat'}
          onPress={() => connection.mute(current, !muted)}
        />
      ) : null}
      <HeaderIcon icon="search" label="Search" onPress={onSearch} />
      <HeaderIcon icon="pin" label="Pinned messages" onPress={onPins} />
    </View>
  );
}

// chat.css's #dm-header: padding 8px 16px, 6px apart, a line under it, the name bold.
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  text: { flex: 1, minWidth: 0 },  // (minWidth 0: a long name shrinks and gets its "…")
  name: { fontWeight: '600', fontSize: 16, color: colors.text },
  // #group-members: 0.75rem, muted.
  members: { fontSize: 12, color: colors.textMuted },
  // .header-icon: padding 4px 8px, radius 6px; pressed like :hover.
  icon: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 },
  iconPressed: { backgroundColor: colors.bgHover },
});
