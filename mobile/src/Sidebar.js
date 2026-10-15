// The left drawer: the web page's #sidebar. People (with a count of friend requests), the channels
// under their headings, Direct messages (groups first, then a DM with each friend), and your own
// panel at the bottom. Unread chats are white and bold with a dot on the left; mentions of you get
// a red count on the right.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { colors } from './colors';
import { dmKey, groupName } from './chats';
import { GroupPicture, Person, PersonPicture } from './people';

// One row of the list, like the web page's .channel buttons. `children` is a function that draws
// what's in it, told whether the text should be white (`strong`) and bold (unread).
// (Defined out here, not inside Sidebar: a component defined inside another is a new one at every
// redraw, so React would rebuild every row each time, pictures included.)
// A muted chat is faded and has no unread dot (a red count still shows: a mention by name).
function Row({ chatKey, active, unread, mentions, mutedChats, onPress, children }) {
  const muted = chatKey && mutedChats.has(chatKey);
  const isUnread = chatKey && unread.has(chatKey) && !active && !muted;
  const count = (chatKey && mentions[chatKey]) || 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row, active && styles.active, pressed && !active && styles.pressed, muted && !active && styles.muted,
      ]}
    >
      {isUnread ? <View style={styles.unreadDot} /> : null}
      <View style={styles.rowInside}>{children(active || isUnread, isUnread)}</View>
      {count > 0 ? <View style={styles.mentionBadge}><Text style={styles.badgeText}>{count}</Text></View> : null}
    </Pressable>
  );
}

export default function Sidebar({ connection, view, onPick, onPeople }) {
  const { channels, groups, friends, users, roles, me, myPresence, unread, mentions, mutedChats, incoming } = connection;
  const marks = { unread, mentions, mutedChats };  // every Row gets these: <Row {...marks} ...>

  // The text colour of a row: white when it's the open chat or unread, else muted.
  const textStyle = (strong, bold) => [styles.rowText, strong && styles.rowTextStrong, bold && styles.bold];

  const dms = friends.map((id) => users[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const mine = users[me.id];

  return (
    <View style={styles.sidebar}>
      <ScrollView style={styles.lists} contentContainerStyle={styles.listsInside}>
        <Row {...marks} active={view === 'people'} onPress={onPeople}>
          {(strong) => (
            <>
              <Icon name="users" color={strong ? colors.iconStrong : colors.icon} />
              <Text style={[textStyle(strong), styles.grow]}>People</Text>
              {incoming.length > 0 ? (
                <View style={styles.badge}><Text style={styles.badgeText}>{incoming.length}</Text></View>
              ) : null}
            </>
          )}
        </Row>

        {channels.map((channel) => (channel.heading ? (
          <Text key={channel.key} style={styles.heading}>{channel.name}</Text>
        ) : (
          <Row {...marks} key={channel.key} chatKey={channel.key} active={view === channel.key} onPress={() => onPick(channel.key)}>
            {(strong, bold) => <Text numberOfLines={1} style={[textStyle(strong, bold), styles.grow]}># {channel.name}</Text>}
          </Row>
        )))}

        <Text style={styles.heading}>Direct messages</Text>
        {groups.map((group) => (
          <Row {...marks} key={group.key} chatKey={group.key} active={view === group.key} onPress={() => onPick(group.key)}>
            {(strong, bold) => (
              <View style={styles.person}>
                <GroupPicture />
                <Text numberOfLines={1} style={[textStyle(strong, bold), styles.grow]}>{groupName(group, users, me.id)}</Text>
              </View>
            )}
          </Row>
        ))}
        {dms.map((user) => {
          const key = dmKey(me.id, user.id);
          return (
            <Row {...marks} key={key} chatKey={key} active={view === key} onPress={() => onPick(key)}>
              {(strong, bold) => (
                <Person
                  user={user} roles={roles} me={me} myPresence={myPresence} bold={bold}
                  color={strong ? colors.textStrong : colors.textMuted}
                  ring={view === key ? colors.bgActive : colors.bgPanel}
                />
              )}
            </Row>
          );
        })}
      </ScrollView>

      {/* You, at the bottom (the web page's #user-panel): your picture with your status, and your name. */}
      {mine ? (
        <View style={styles.userPanel}>
          <PersonPicture user={mine} me={me} myPresence={myPresence} size={40} ring={colors.bgPanelAlt} />
          <Text numberOfLines={1} style={styles.myName}>{mine.name}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: { flex: 1, backgroundColor: colors.bgPanel },
  lists: { flex: 1 },
  listsInside: { paddingHorizontal: 8, paddingTop: 16, paddingBottom: 8, gap: 2 },
  // .section-heading: 0.75rem, uppercase, muted, margin 16px 0 8px, padding 0 12px.
  heading: {
    color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase',
    marginTop: 16, marginBottom: 8, paddingHorizontal: 12,
  },
  // .channel on a phone: padding 12px, radius 6px.
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 6 },
  rowInside: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  active: { backgroundColor: colors.bgActive },
  pressed: { backgroundColor: colors.bgHover },
  muted: { opacity: 0.5 },  // .channel.muted
  rowText: { color: colors.textMuted, fontSize: 16 },
  rowTextStrong: { color: colors.textStrong },
  bold: { fontWeight: '600' },
  grow: { flex: 1 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  // The unread dot: 8px, white, on the row's left edge.
  unreadDot: { position: 'absolute', left: 1, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textStrong },
  // .mention-badge: a red pill with the count, at the row's right end.
  mentionBadge: {
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 5, marginLeft: 6,
    backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center',
  },
  // .badge (friend requests): 18px tall.
  badge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center',
  },
  badgeText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  userPanel: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: colors.bgPanelAlt },
  myName: { flex: 1, color: colors.textStrong, fontSize: 13.6, fontWeight: '600' },
});
