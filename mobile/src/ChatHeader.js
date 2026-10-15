// What the top bar shows for a chat (App.js): its name (a group's members under it), and the web
// page's #dm-header buttons: the bell (mute), search and the pinned messages. (On the web page these
// are a second bar under the top one; in the app they share the top bar, the user's wish.) The call
// button and a group's buttons come with their own steps.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { chatLabel, dmPartner } from './chats';
import { colors } from './colors';

// The name, and in a group its members underneath: "you, kari, ola".
export function ChatTitle({ connection, chatKey }) {
  const { groups, users, me } = connection;
  const group = groups.find((g) => g.key === chatKey);
  const members = group?.members.map((id) => (id === me.id ? 'you' : users[id]?.name ?? 'someone')).join(', ');
  return (
    <View style={styles.title}>
      <Text style={styles.name} numberOfLines={1}>{chatLabel(chatKey, connection)}</Text>
      {group ? <Text style={styles.members} numberOfLines={1}>{members}</Text> : null}
    </View>
  );
}

function HeaderIcon({ icon, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.icon, pressed && styles.iconPressed]}
    >
      <Icon name={icon} size={22} color={colors.text} />
    </Pressable>
  );
}

// onPopup("search" or "pins"): open that popup (the chat screen draws it).
export function ChatButtons({ connection, chatKey, onPopup }) {
  const { users, me, mutedChats } = connection;
  // The bell mutes this chat, the crossed-out bell unmutes it. Not in a DM with an admin: admins
  // can't be muted (the server's can_mute).
  const muted = mutedChats.has(chatKey);
  const showBell = muted || users[dmPartner(chatKey, me.id)]?.admin !== true;
  return (
    <>
      {showBell ? (
        <HeaderIcon
          icon={muted ? 'bell-off' : 'bell'}
          label={muted ? 'Unmute this chat' : 'Mute this chat'}
          onPress={() => connection.mute(chatKey, !muted)}
        />
      ) : null}
      <HeaderIcon icon="search" label="Search" onPress={() => onPopup('search')} />
      <HeaderIcon icon="pin" label="Pinned messages" onPress={() => onPopup('pins')} />
    </>
  );
}

const styles = StyleSheet.create({
  title: { flex: 1, minWidth: 0 },  // (minWidth 0: a long name shrinks and gets its "…")
  name: { fontSize: 16, fontWeight: '600', color: colors.textStrong },
  // #group-members: 0.75rem, muted.
  members: { fontSize: 12, color: colors.textMuted },
  // A little narrower than the menu and members buttons, so five fit beside the name.
  icon: { paddingHorizontal: 7, paddingVertical: 8, borderRadius: 6 },
  iconPressed: { backgroundColor: colors.bgHover },
});
