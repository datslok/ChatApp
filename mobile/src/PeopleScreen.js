// Friends: requests to answer, friends (with their DM), requests we sent, people we blocked, and
// a search box to find anyone else and add them (like the web page's People page).
import { useEffect, useState } from 'react';
import { Alert, BackHandler, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from './colors';
import { dmKey } from './ChannelsScreen';
import StatusDot from './StatusDot';

export default function PeopleScreen({ connection, onBack }) {
  const { users, me, friends, incoming, outgoing, blocked, friendAction, openChat } = connection;
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  // Android's back button: back to the chats.
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => listener.remove();
  }, []);

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

  // The buttons for one person, depending on how we're connected (the web page's makeFriendButtons).
  function buttonsFor(user) {
    const buttons = [];
    const add = (label, onPress, kind) => buttons.push({ label, onPress, kind });
    if (blocked.includes(user.id)) {
      add('Unblock', () => act('unblock', user.id), 'grey');
      return buttons;  // nothing else until they're unblocked
    }
    if (friends.includes(user.id)) {
      add('Message', () => openChat(dmKey(me.id, user.id)), 'blue');
      if (!user.bot) add('Remove', () => act('remove', user.id), 'grey');  // bots are everyone's friend
    } else if (incoming.includes(user.id)) {
      add('Accept', () => act('accept', user.id), 'green');
      add('Decline', () => act('remove', user.id), 'grey');
    } else if (outgoing.includes(user.id)) {
      add('Cancel', () => act('remove', user.id), 'grey');
    } else {
      add('Add friend', () => act('request', user.id), 'green');
    }
    // Block: never admins (the chat's rule) or bots. The server checks too.
    if (!user.admin && !user.bot) {
      add('Block', () => confirmBlock(user), 'grey');
    }
    return buttons;
  }

  // Everyone else, alphabetically. Searching: anyone whose name contains the text.
  const everyone = Object.values(users)
    .filter((user) => user.id !== me.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const ids = (list) => everyone.filter((user) => list.includes(user.id));

  const rows = [];
  function section(title, list, emptyText) {
    if (list.length === 0 && !emptyText) return;  // (a section with nothing in it isn't shown)
    rows.push({ key: 'heading:' + title, heading: `${title} (${list.length})` });
    if (list.length === 0) rows.push({ key: 'empty:' + title, empty: emptyText });
    for (const user of list) rows.push({ key: title + user.id, user });
  }
  const typed = query.trim().toLowerCase();
  if (typed) {
    section('Results', everyone.filter((user) => user.name.toLowerCase().includes(typed)), 'Nobody by that name.');
  } else {
    section('Friend requests', ids(incoming));
    section('Friends', ids(friends), 'No friends yet. Search above to add someone.');
    section('Sent requests', ids(outgoing));
    section('Blocked', ids(blocked));
  }

  function renderRow({ item }) {
    if (item.heading) return <Text style={styles.heading}>{item.heading}</Text>;
    if (item.empty) return <Text style={styles.empty}>{item.empty}</Text>;
    const { user } = item;
    return (
      <View style={styles.row}>
        <StatusDot user={user} />
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>
            {user.name}{user.bot ? <Text style={styles.bot}>  BOT</Text> : null}
          </Text>
          {user.status ? <Text style={styles.status} numberOfLines={1}>{user.status}</Text> : null}
        </View>
        {buttonsFor(user).map((button) => (
          <Pressable
            key={button.label}
            onPress={button.onPress}
            style={({ pressed }) => [styles.button, styles[button.kind], pressed && styles.pressed]}
          >
            <Text style={styles.buttonText}>{button.label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <Text style={styles.title}>People</Text>
      </View>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search for someone"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList data={rows} renderItem={renderRow} keyboardShouldPersistTaps="handled" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.bgDarkest,
  },
  back: { paddingRight: 12 },
  backText: { color: colors.textSoft, fontSize: 24 },
  title: { flex: 1, color: colors.textStrong, fontSize: 18, fontWeight: 'bold' },
  search: {
    margin: 12, backgroundColor: colors.bgDarkest, color: colors.text, fontSize: 16,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
  },
  error: { color: colors.red, paddingHorizontal: 16, paddingBottom: 8 },
  heading: {
    color: colors.textMuted, fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase',
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6,
  },
  empty: { color: colors.textMuted, paddingHorizontal: 16, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10 },
  who: { flex: 1 },
  name: { color: colors.textStrong, fontSize: 16 },
  bot: { color: colors.accent, fontSize: 11, fontWeight: 'bold' },
  status: { color: colors.textMuted, fontSize: 13 },
  button: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 7 },
  blue: { backgroundColor: colors.accent },
  green: { backgroundColor: colors.buttonGreen },
  grey: { backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.7 },
  buttonText: { color: colors.textStrong, fontSize: 13, fontWeight: 'bold' },
});
