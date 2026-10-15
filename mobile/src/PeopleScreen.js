// The People page, like the web page's (#friends-view, people.js renderPeopleList): a heading with
// four tabs (Friends, Everyone, Requests, Blocked); Everyone has a search box and Online / Offline;
// Requests has Received / Sent. Each person's row has the buttons that fit how we stand with them.
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStyles, useTheme } from './theme';
import { friendButtons } from './friends';
import { Person } from './people';

const TABS = [
  { key: 'friends', label: 'Friends' },
  { key: 'everyone', label: 'Everyone' },
  { key: 'requests', label: 'Requests' },
  { key: 'blocked', label: 'Blocked' },
];

// onOpen(key): open that chat (App.js's go). onProfile(id), onUserMenu(id): a row's tap and long press.
// onInvite: the Invite someone popup.
export default function PeopleScreen({ connection, onOpen, onProfile, onUserMenu, onInvite }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { users, roles, me, myPresence, friends, incoming, outgoing, blocked, friendAction } = connection;
  const [tab, setTab] = useState('friends');
  const [query, setQuery] = useState('');   // the Everyone tab's search box
  const [error, setError] = useState('');   // what the server said no with, under the list

  async function act(action, userId) {
    setError('');
    const problem = await friendAction(action, userId);
    if (problem) setError(problem);
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
      // (The buttons inside are touch areas of their own: a tap on one does its thing, not the profile.)
      <Pressable
        onPress={() => onProfile(user.id)}
        onLongPress={() => onUserMenu(user.id)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <Person user={user} roles={roles} me={me} myPresence={myPresence} color={colors.text} ring={colors.bgMain} />
        <View style={styles.actions}>
          {friendButtons(user, connection, act, onOpen).map((button) => (
            <Pressable
              key={button.label}
              onPress={button.onPress}
              style={({ pressed }) => [styles.button, button.secondary && styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.buttonText}>{button.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    );
  }

  return (
    <View style={styles.page}>
      {/* .friends-header: "People" and the tabs, which go below it when they don't fit beside it. */}
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        {/* #invite-button: green, at the end of the heading's line. */}
        <Pressable onPress={onInvite} style={({ pressed }) => [styles.invite, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>Invite someone</Text>
        </Pressable>
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
const makeStyles = (colors, size) => StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, paddingVertical: 16, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 8,
    paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  title: { fontSize: size(17.6), fontWeight: 'bold', color: colors.textStrong },
  // #invite-button: margin-left auto (to the end), padding 6px 12px, the green button colour, 0.9rem.
  invite: { marginLeft: 'auto', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.buttonGreen },
  // On a phone the four tabs don't fit side by side at the web page's size (they wrapped, Blocked on a
  // line of its own), so here they share the whole width equally.
  tabs: { flexDirection: 'row', gap: 4, width: '100%' },
  tab: { flex: 1, alignItems: 'center', paddingHorizontal: 4, paddingVertical: 6, borderRadius: 6 },
  tabActive: { backgroundColor: colors.bgActive },
  tabText: { fontSize: size(15.2), color: colors.textMuted },
  tabTextActive: { color: colors.textStrong },
  search: {
    marginTop: 12, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
    backgroundColor: colors.bgDarkest, color: colors.text, fontSize: size(16),
  },
  subheading: { marginTop: 12, marginBottom: 4, fontSize: size(12), textTransform: 'uppercase', color: colors.textMuted },
  empty: { marginVertical: 4, marginHorizontal: 12, fontSize: size(13.6), color: colors.textMuted },
  // .people-row: the person on the left, the buttons on the right, a line under each.
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.bgHover },
  actions: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  button: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(13.6) },
  status: { marginTop: 8, fontSize: size(13.6), color: colors.red },
});
