// The whole app: one connection to the server, and the web page's phone layout. A top bar (menu,
// the chat's name, the member list), the chat under it, and two drawers that slide over it: the
// channels on the left, the chat's members on the right.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ChatButtons, ChatTitle } from './src/ChatHeader';
import ChatScreen from './src/ChatScreen';
import Drawer from './src/Drawer';
import Icon from './src/Icon';
import LoginScreen from './src/LoginScreen';
import Members from './src/Members';
import PeopleScreen from './src/PeopleScreen';
import ShareScreen from './src/ShareScreen';
import Sidebar from './src/Sidebar';
import { dmPartner } from './src/chats';
import { colors } from './src/colors';
import { useConnection } from './src/connection';
import { clearOldCopies } from './src/files';
import { addShareListener, getInitialShare } from './modules/shared-files';

const PEOPLE = 'people';  // the People page's name among the chats' keys (like the web page's FRIENDS)

// share: something shared to the app from another one, waiting for "Share to…" (or null);
// onShareDone: it's been dealt with (sent to a chat or cancelled).
function Main({ connection, share, onShareDone }) {
  const { channels, unread, mentions, incoming } = connection;
  const [view, setView] = useState(null);      // the chat on screen (its key), or PEOPLE
  const [drawer, setDrawer] = useState(null);  // the open drawer: "left", "right" or null
  // The chat's popup that's open ("search" or "pins", from the top bar's buttons), or null. The chat
  // screen draws it: its Jump buttons go to messages there.
  const [popup, setPopup] = useState(null);
  // The chats we came from, for the back button (newest last). A ref: changing it redraws nothing.
  const history = useRef([]);
  const chatBack = useRef(null);  // what the chat screen wants the back button to do first, if anything
  const [toTray, setToTray] = useState(null);  // a share on its way into the chat screen's tray
  // Each chat's tray, {chatKey: [files]}, and half-written text, {chatKey: text}: each chat keeps its own,
  // like Discord, so a picture picked or words typed in a DM stay there when you go elsewhere. Kept
  // here, as the chat screen goes away on the People page.
  const [trays, setTrays] = useState({});
  const [drafts, setDrafts] = useState({});
  // A share asks "Share to…" when it started the app, or when no chat is open (the People page).
  const pickChat = !!share && (share.fromStart || view === PEOPLE);

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

  // Looking at a DM with someone who's no longer a friend (removed, blocked), or a group we're no
  // longer in? Then it's gone: off to the first channel, like the web page.
  useEffect(() => {
    const first = channels.find((channel) => !channel.heading);
    const partner = dmPartner(view, connection.me.id);
    const goneDm = partner !== null && !connection.friends.includes(partner);
    const goneGroup = view?.startsWith('g:') && !connection.groups.some((group) => group.key === view);
    if ((goneDm || goneGroup) && first) {
      history.current = history.current.filter((key) => key !== view);
      go(first.key, false);
    }
  }, [connection.friends, connection.groups]);

  // Android's back button, the web page's way: close an open drawer, else back to the chat before.
  // With nowhere left to go, returning false lets Android do its own thing (leave the app).
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pickChat) {  // back on "Share to…" cancels the share
        onShareDone();
        return true;
      }
      if (chatBack.current?.()) return true;  // the chat screen had something to close (the emoji panel)
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
  }, [drawer, view, pickChat]);

  // Something shared to the app while it was open, in a chat: straight into that chat (the chat screen
  // takes the files into its tray and the text into the text box).
  useEffect(() => {
    if (share && view !== null && !pickChat) {
      setToTray(share);
      onShareDone();
    }
  }, [share, view]);

  if (view === null) return <Loading />;

  // Shared when the app wasn't open yet (or we're on the People page): first "Share to…", which then
  // opens the chosen chat with it.
  if (pickChat) {
    const pick = (key) => {
      setToTray(share);
      onShareDone();
      go(key);
    };
    return <ShareScreen connection={connection} share={share} onPick={pick} onCancel={onShareDone} />;
  }

  // The red dot on the menu button: something unread somewhere else (a chat that isn't muted, a
  // mention, a request).
  const elsewhere = (key) => key !== view;
  const somethingNew = [...unread].some((key) => elsewhere(key) && !connection.mutedChats.has(key))
    || Object.keys(mentions).some((key) => elsewhere(key) && mentions[key] > 0)
    || incoming.length > 0;

  return (
    // KeyboardAvoidingView: when the keyboard opens, it adds room at the bottom the keyboard's height,
    // so the text box sits just above the keyboard. Around everything, because it measures its own
    // position from its parent: lower down (in ChatScreen, under the top bar) it got the sum wrong
    // and left the text box partly behind the keyboard.
    <KeyboardAvoidingView style={styles.main} behavior="padding">
      {/* The web page's #topbar on a phone. */}
      <View style={styles.topbar}>
        <Pressable onPress={() => setDrawer('left')} style={styles.topbarButton} hitSlop={4}>
          <Icon name="menu" size={22} color={colors.text} />
          {somethingNew ? <View style={styles.newDot} /> : null}
        </Pressable>
        {view === PEOPLE ? <Text numberOfLines={1} style={styles.title}>People</Text> : (
          <>
            <ChatTitle connection={connection} chatKey={view} />
            {/* Mute, search, pins: the web page's #dm-header buttons, here in the top bar itself. */}
            <ChatButtons connection={connection} chatKey={view} onPopup={setPopup} />
          </>
        )}
        {view === PEOPLE ? <View style={styles.topbarButton} /> : (
          <Pressable onPress={() => setDrawer('right')} style={styles.topbarButton} hitSlop={4}>
            <Icon name="users" size={22} color={colors.text} />
          </Pressable>
        )}
      </View>
      {connection.status !== 'online' ? <Text style={styles.offline}>Reconnecting…</Text> : null}

      <View style={styles.content}>
        {view === PEOPLE
          ? <PeopleScreen connection={connection} onOpen={go} />
          : <ChatScreen connection={connection} backRef={chatBack} shared={toTray} onSharedTaken={() => setToTray(null)} trays={trays} setTrays={setTrays} drafts={drafts} setDrafts={setDrafts} onOpenChat={go} popup={popup} setPopup={setPopup} />}
      </View>

      <Drawer side="left" open={drawer === 'left'} onClose={() => setDrawer(null)}>
        <Sidebar connection={connection} view={view} onPick={go} onPeople={() => go(PEOPLE)} />
      </Drawer>
      <Drawer side="right" open={drawer === 'right'} onClose={() => setDrawer(null)}>
        <Members connection={connection} view={view} />
      </Drawer>
    </KeyboardAvoidingView>
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

function Screen({ share, onShareDone }) {
  const connection = useConnection();
  const { status, me } = connection;
  if (status === 'logged-out') return <LoginScreen onLoggedIn={connection.reconnect} />;
  // Not connected yet (we don't know who we are until "welcome").
  if (me === null) return <Loading text={status === 'offline' ? "Can't reach the server, trying again…" : null} />;
  return <Main connection={connection} share={share} onShareDone={onShareDone} />;
}

export default function App() {
  // Something shared to the app (modules/shared-files): kept up here, so it waits through the
  // login screen and the connecting.
  const [share, setShare] = useState(null);
  useEffect(() => {
    // Once at the start: throw away last time's copies (files.js). Before anything new is shared.
    clearOldCopies();
    // Were we started by a share? (fromStart: then we ask which chat.) And from now on, a share while
    // we're open goes into the open chat.
    getInitialShare().then((first) => first && setShare({ ...first, fromStart: true })).catch(() => {});
    const subscription = addShareListener((next) => setShare({ ...next, fromStart: false }));
    return () => subscription.remove();
  }, []);
  // Android draws apps "edge to edge", under the status bar and the navigation bar.
  // SafeAreaView adds padding the size of those bars, so nothing ends up behind them.
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <Screen share={share} onShareDone={() => setShare(null)} />
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
