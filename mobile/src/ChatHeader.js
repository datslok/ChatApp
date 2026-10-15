// What the top bar shows for a chat (App.js): its name (a group's members under it), and the web
// page's #dm-header buttons: the bell (mute), search and the pinned messages. (On the web page these
// are a second bar under the top one; in the app they share the top bar, the user's wish.) In a group
// also ⋯, its menu (Add people, Rename, Leave: on the web page three buttons in that bar). The call
// button comes with calls.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { chatLabel, dmPartner } from './chats';
import { useStyles, useTheme } from './theme';

// The name, and in a group its members underneath: "you, kari, ola".
export function ChatTitle({ connection, chatKey }) {
  const styles = useStyles(makeStyles);
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
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
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

// onPopup("search" or "pins"): open that popup (the chat screen draws it). onGroupMenu: open a
// group's menu.
export function ChatButtons({ connection, chatKey, onPopup, onGroupMenu }) {
  const { users, me, mutedChats, groups } = connection;
  const isGroup = groups.some((group) => group.key === chatKey);
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
      {isGroup ? <HeaderIcon icon="ellipsis-vertical" label="Group options" onPress={onGroupMenu} /> : null}
    </>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  title: { flex: 1, minWidth: 0 },  // (minWidth 0: a long name shrinks and gets its "…")
  name: { fontSize: size(16), fontWeight: '600', color: colors.textStrong },
  // #group-members: 0.75rem, muted.
  members: { fontSize: size(12), color: colors.textMuted },
  // A little narrower than the menu and members buttons, so all of them fit beside the name.
  icon: { paddingHorizontal: 6, paddingVertical: 8, borderRadius: 6 },
  iconPressed: { backgroundColor: colors.bgHover },
});
