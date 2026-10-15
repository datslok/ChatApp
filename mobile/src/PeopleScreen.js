// The People page, like the web page's (#friends-view, people.js renderPeopleList): a heading with
// four tabs (Friends, Everyone, Requests, Blocked); Everyone has a search box and Online / Offline;
// Requests has Received / Sent. Each person's row has the buttons that fit how we stand with them.
import { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from './colors';
import { dmKey } from './chats';
import { Person } from './people';

const TABS = [
  { key: 'friends', label: 'Friends' },
  { key: 'everyone', label: 'Everyone' },
  { key: 'requests', label: 'Requests' },
  { key: 'blocked', label: 'Blocked' },
];

// onOpen(key): open that chat (App.js's go).
export default function PeopleScreen({ connection, onOpen }) {
  const { users, roles, me, myPresence, friends, incoming, outgoing, blocked, friendAction } = connection;
  const [tab, setTab] = useState('friends');
  const [query, setQuery] = useState('');   // the Everyone tab's search box
  const [error, setError] = useState('');   // what the server said no with, under the list

  async function act(action, userId) {
    setError('');
    const problem = await friendAction(action, userId);
    if (problem) setError(problem);
  }

  function confirmBlock(user) {
    Alert.alert(
      `Block ${user.name}?`,
      "You stop being friends, and their messages are hidden for you. They aren't told.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Block', style: 'destructive', onPress: () => act('block', user.id) },
      ],
    );
  }

  // The buttons for one person, depending on how we're connected (the web page's makeFriendButtons):
  // blue for the main one, grey ("secondary") for the rest.
  function buttonsFor(user) {
    const buttons = [];
    const add = (label, onPress, secondary) => buttons.push({ label, onPress, secondary });
    if (blocked.includes(user.id)) {
      add('Unblock', () => act('unblock', user.id), true);
      return buttons;  // nothing else until they're unblocked: no friend request, no DM
    }
    if (friends.includes(user.id)) {
      add('Message', () => onOpen(dmKey(me.id, user.id)));
      if (!user.bot) add('Remove', () => act('remove', user.id), true);  // bots are everyone's friend
    } else if (incoming.includes(user.id)) {
      add('Accept', () => act('accept', user.id));
      add('Decline', () => act('remove', user.id), true);
    } else if (outgoing.includes(user.id)) {
      add('Cancel request', () => act('remove', user.id), true);
    } else {
      add('Add friend', () => act('request', user.id));
    }
    // Block: never admins (the chat's rule) or bots. The server checks too.
    if (!user.admin && !user.bot) add('Block', () => confirmBlock(user), true);
    return buttons;
  }

  // Everyone but us, alphabetically (the web page keeps the server's order, which is that).
  const everyone = Object.values(users)
    .filter((user) => user.id !== me.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const among = (ids) => everyone.filter((user) => ids.includes(user.id));

  // The list's rows: subheadings, people, and a note where a section is empty.
  const rows = [];
  function section(title, people, emptyText) {
    if (title) rows.push({ key: 'heading:' + title, heading: title });
    for (const user of people) rows.push({ key: `${title}:${user.id}`, user });
    if (people.length === 0) rows.push({ key: 'empty:' + title, empty: emptyText });
  }
  if (tab === 'friends') {
    section('', among(friends), 'No friends yet. Find people in the Everyone tab and add them.');
  } else if (tab === 'everyone') {
    const typed = query.trim().toLowerCase();
    const found = everyone.filter((user) => user.name.toLowerCase().includes(typed));
    const online = found.filter((user) => user.online);
    const offline = found.filter((user) => !user.online);
    section(`Online — ${online.length}`, online, typed ? 'Nobody online by that name.' : 'Nobody else is online.');
    section(`Offline — ${offline.length}`, offline, typed ? 'Nobody offline by that name.' : 'Nobody is offline.');
  } else if (tab === 'blocked') {
    section('', among(blocked), "You haven't blocked anyone.");
  } else {
    section('Received', among(incoming), 'No requests waiting.');
    section('Sent', among(outgoing), "You haven't sent any requests.");
  }

  function pickTab(key) {
    setTab(key);
    setError('');
  }

  function renderRow({ item }) {
    if (item.heading) return <Text style={styles.subheading}>{item.heading}</Text>;
    if (item.empty) return <Text style={styles.empty}>{item.empty}</Text>;
    const { user } = item;
    return (
      <View style={styles.row}>
        <Person user={user} roles={roles} me={me} myPresence={myPresence} color={colors.text} ring={colors.bgMain} />
        <View style={styles.actions}>
          {buttonsFor(user).map((button) => (
            <Pressable
              key={button.label}
              onPress={button.onPress}
              style={({ pressed }) => [styles.button, button.secondary && styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.buttonText}>{button.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      {/* .friends-header: "People" and the tabs, which go below it when they don't fit beside it. */}
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        <View style={styles.tabs}>
          {TABS.map(({ key, label }) => (
            <Pressable key={key} onPress={() => pickTab(key)} style={[styles.tab, tab === key && styles.tabActive]}>
              {/* adjustsFontSizeToFit: a long label ("Requests (2)") shrinks a little to stay on one line. */}
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.tabText, tab === key && styles.tabTextActive]}>
                {label}{key === 'requests' && incoming.length > 0 ? ` (${incoming.length})` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {tab === 'everyone' ? (
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search everyone"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}
      <FlatList data={rows} renderItem={renderRow} keyboardShouldPersistTaps="handled" />
      {error ? <Text style={styles.status}>{error}</Text> : null}
    </View>
  );
}

// chat.css's People page (#friends-view and friends), rem as 16 px.
const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, paddingVertical: 16, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 8,
    paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  title: { fontSize: 17.6, fontWeight: 'bold', color: colors.textStrong },
  // On a phone the four tabs don't fit side by side at the web page's size (they wrapped, Blocked on a
  // line of its own), so here they share the whole width equally.
  tabs: { flexDirection: 'row', gap: 4, width: '100%' },
  tab: { flex: 1, alignItems: 'center', paddingHorizontal: 4, paddingVertical: 6, borderRadius: 6 },
  tabActive: { backgroundColor: colors.bgActive },
  tabText: { fontSize: 15.2, color: colors.textMuted },
  tabTextActive: { color: colors.textStrong },
  search: {
    marginTop: 12, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
    backgroundColor: colors.bgDarkest, color: colors.text, fontSize: 16,
  },
  subheading: { marginTop: 12, marginBottom: 4, fontSize: 12, textTransform: 'uppercase', color: colors.textMuted },
  empty: { marginVertical: 4, marginHorizontal: 12, fontSize: 13.6, color: colors.textMuted },
  // .people-row: the person on the left, the buttons on the right, a line under each.
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  actions: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  button: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: 13.6 },
  status: { marginTop: 8, fontSize: 13.6, color: colors.red },
});
