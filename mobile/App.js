// The whole app: one connection to the server, and the web page's phone layout. A top bar (menu,
// the chat's name, the member list), the chat under it, and two drawers that slide over it: the
// channels on the left, the chat's members on the right.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ChatScreen from './src/ChatScreen';
import Drawer from './src/Drawer';
import Icon from './src/Icon';
import LoginScreen from './src/LoginScreen';
import Members from './src/Members';
import PeopleScreen from './src/PeopleScreen';
import Sidebar from './src/Sidebar';
import { chatLabel } from './src/chats';
import { colors } from './src/colors';
import { useConnection } from './src/connection';

const PEOPLE = 'people';  // the People page's name among the chats' keys (like the web page's FRIENDS)

function Main({ connection }) {
  const { channels, unread, mentions, incoming } = connection;
  const [view, setView] = useState(null);      // the chat on screen (its key), or PEOPLE
  const [drawer, setDrawer] = useState(null);  // the open drawer: "left", "right" or null
  // The chats we came from, for the back button (newest last). A ref: changing it redraws nothing.
  const history = useRef([]);

  function go(key, remember = true) {
    if (remember && view !== null && view !== key) history.current.push(view);
    setView(key);
    setDrawer(null);  // picking a chat closes the drawer, like the web page's switchChannel
    if (key === PEOPLE) connection.closeChat();  // in no chat: new messages anywhere count as unread
    else connection.openChat(key);
  }

  // At the start: the first channel (the web page opens one too).
  useEffect(() => {
    const first = channels.find((channel) => !channel.heading);
    if (view === null && first) go(first.key, false);
  }, [channels]);

  // Android's back button, the web page's way: close an open drawer, else back to the chat before.
  // With nowhere left to go, returning false lets Android do its own thing (leave the app).
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (drawer) {
        setDrawer(null);
        return true;
      }
      const previous = history.current.pop();
      if (previous) {
        go(previous, false);
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [drawer, view]);

  if (view === null) return <Loading />;

  // The red dot on the menu button: something unread somewhere else (a chat, a mention, a request).
  const elsewhere = (key) => key !== view;
  const somethingNew = [...unread].some(elsewhere)
    || Object.keys(mentions).some((key) => elsewhere(key) && mentions[key] > 0)
    || incoming.length > 0;

  return (
    <View style={styles.main}>
      {/* The web page's #topbar on a phone. */}
      <View style={styles.topbar}>
        <Pressable onPress={() => setDrawer('left')} style={styles.topbarButton} hitSlop={4}>
          <Icon name="menu" size={22} color={colors.text} />
          {somethingNew ? <View style={styles.newDot} /> : null}
        </Pressable>
        <Text numberOfLines={1} style={styles.title}>{view === PEOPLE ? 'People' : chatLabel(view, connection)}</Text>
        {view === PEOPLE ? <View style={styles.topbarButton} /> : (
          <Pressable onPress={() => setDrawer('right')} style={styles.topbarButton} hitSlop={4}>
            <Icon name="users" size={22} color={colors.text} />
          </Pressable>
        )}
      </View>
      {connection.status !== 'online' ? <Text style={styles.offline}>Reconnecting…</Text> : null}

      <View style={styles.content}>
        {view === PEOPLE ? <PeopleScreen connection={connection} onOpen={go} /> : <ChatScreen connection={connection} />}
      </View>

      <Drawer side="left" open={drawer === 'left'} onClose={() => setDrawer(null)}>
        <Sidebar connection={connection} view={view} onPick={go} onPeople={() => go(PEOPLE)} />
      </Drawer>
      <Drawer side="right" open={drawer === 'right'} onClose={() => setDrawer(null)}>
        <Members connection={connection} view={view} />
      </Drawer>
    </View>
  );
}

function Loading({ text }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.textMuted} size="large" />
      {text ? <Text style={styles.loadingText}>{text}</Text> : null}
    </View>
  );
}

function Screen() {
  const connection = useConnection();
  const { status, me } = connection;
  if (status === 'logged-out') return <LoginScreen onLoggedIn={connection.reconnect} />;
  // Not connected yet (we don't know who we are until "welcome").
  if (me === null) return <Loading text={status === 'offline' ? "Can't reach the server, trying again…" : null} />;
  return <Main connection={connection} />;
}

export default function App() {
  // Android draws apps "edge to edge", under the status bar and the navigation bar.
  // SafeAreaView adds padding the size of those bars, so nothing ends up behind them.
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <Screen />
        <StatusBar style="light" />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.bgMain },
  main: { flex: 1 },
  // #topbar: gap 4px, padding 4px, a line under it.
  topbar: {
    flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgMain,
  },
  topbarButton: { paddingHorizontal: 12, paddingVertical: 8, minWidth: 46 },
  newDot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  title: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.textStrong },
  offline: { backgroundColor: colors.red, color: colors.textStrong, textAlign: 'center', paddingVertical: 4 },
  content: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, backgroundColor: colors.bgMain },
  loadingText: { color: colors.textMuted },
});
