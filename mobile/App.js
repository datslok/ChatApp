// The whole app: one connection to the server, and the web page's phone layout. A top bar (menu,
// the chat's name, the member list), the chat under it, and two drawers that slide over it: the
// channels on the left, the chat's members on the right.
import { File, Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ChatButtons, ChatTitle } from './src/ChatHeader';
import BanDialog from './src/BanDialog';
import CallBanner, { hasCallBanner } from './src/CallBanner';
import CallFloat from './src/CallFloat';
import ChatScreen from './src/ChatScreen';
import Drawer from './src/Drawer';
import { GroupDialog, GroupMenu, RenameDialog } from './src/GroupScreen';
import Icon from './src/Icon';
import IncomingCall from './src/IncomingCall';
import InviteScreen from './src/InviteScreen';
import LoginScreen from './src/LoginScreen';
import LoungeScreen from './src/LoungeScreen';
import MeScreen from './src/MeScreen';
import Members from './src/Members';
import PeopleScreen from './src/PeopleScreen';
import ProfileScreen from './src/ProfileScreen';
import SettingsScreen from './src/SettingsScreen';
import SeasonScreen from './src/SeasonScreen';
import ShareScreen from './src/ShareScreen';
import Sidebar from './src/Sidebar';
import UpdateScreen from './src/UpdateScreen';
import UserMenu from './src/UserMenu';
import { useChangelog } from './src/changelog';
import { dmPartner } from './src/chats';
import { ThemeContext, loadAppearance, makeTheme, saveAppearance, useStyles, useTheme } from './src/theme';
import { useConnection } from './src/connection';
import { LOUNGE, LOUNGE_ROOM, useVoice } from './src/voice';
import { clearOldCopies } from './src/files';
import { isMuted, useNotifications } from './src/notifications';
import { restored, useLiveUpdates } from './src/liveUpdates';
import { addShareListener, getInitialShare } from './modules/shared-files';
import { addOpenListener, getInitialOpen } from './modules/push';

const PEOPLE = 'people';  // the People page's name among the chats' keys (like the web page's FRIENDS)

// The chat that was open when the app was last closed, kept on this phone (each device its own, the
// user's wish; the web page keeps its own in localStorage). Written by go(), read at the start.
const lastChatFile = new File(Paths.document, 'last-chat.txt');

function lastChat() {
  try {
    if (lastChatFile.exists) return lastChatFile.textSync() || null;
  } catch {}
  return null;
}

function rememberChat(key) {
  try {
    if (!lastChatFile.exists) lastChatFile.create();
    lastChatFile.write(key);
  } catch {}  // (just not kept: the next start opens the first channel)
}

// share: something shared to the app from another one, waiting for "Share to…" (or null);
// onShareDone: it's been dealt with (sent to a chat or cancelled). voice: useVoice()'s (calls);
// openChatRef: we put `go` in it, for the ringing popup's Accept. notifications: useNotifications()'s
// (Settings → Notifications). opened: the notification that was tapped, {channel, messageId, action}
// (modules/push), or null; onOpenedDone: we've gone there.
function Main({ connection, voice, notifications, openChatRef, share, onShareDone, opened, onOpenedDone }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { channels, unread, mentions, incoming } = connection;
  const [view, setView] = useState(null);      // the chat on screen (its key), or PEOPLE
  const [drawer, setDrawer] = useState(null);  // the open drawer: "left", "right" or null
  // The chat's popup that's open ("search" or "pins", from the top bar's buttons), or null. The chat
  // screen draws it: its Jump buttons go to messages there.
  const [popup, setPopup] = useState(null);
  // The popup or menu about people and groups that's open, drawn over everything here (each closes
  // itself with onClose): {type: "profile" or "userMenu", id}, {type: "me"}, {type: "group", key}
  // (key null: a new group), {type: "rename" or "groupMenu", key}, {type: "invites"},
  // {type: "settings", page} (page null: the tab from last time), {type: "ban", id}, {type: "season"}; or null.
  const [dialog, setDialog] = useState(null);
  const closeDialog = () => setDialog(null);
  const [focusTick, setFocusTick] = useState(0);  // a new number: the chat screen puts the cursor in its text box
  // The chats we came from, for the back button (newest last). A ref: changing it redraws nothing.
  const history = useRef([]);
  const chatBack = useRef(null);  // what the chat screen wants the back button to do first, if anything
  const [toTray, setToTray] = useState(null);  // a share on its way into the chat screen's tray
  // Each chat's tray, {chatKey: [files]}, and half-written text, {chatKey: text}: each chat keeps its own,
  // like Discord, so a picture picked or words typed in a DM stay there when you go elsewhere. Kept
  // here, as the chat screen goes away on the People page.
  const [trays, setTrays] = useState({});
  // (After a switch to new JavaScript: as they were just before it, liveUpdates.js.)
  const [drafts, setDrafts] = useState(() => restored?.drafts ?? {});
  // A message to go to, {chat, id} (a tapped notification's), until the chat screen has taken it.
  const [jumpRequest, setJumpRequest] = useState(null);
  // The People page's tab to open on, {tab, at} (a friend request's notification: Requests); `at` (when)
  // is the page's key, so each one starts the page afresh on that tab.
  const [peopleTab, setPeopleTab] = useState(null);
  // A share asks "Share to…" when it started the app, or when no chat is open (the People page).
  const pickChat = !!share && (share.fromStart || view === PEOPLE);
  // What's new: fetched again at every connect (a new `me`), for the red dot on ⚙️ and Settings.
  const changelog = useChangelog(connection.me);

  function go(key, remember = true) {
    if (remember && view !== null && view !== key) history.current.push(view);
    setView(key);
    rememberChat(key);
    setDrawer(null);  // picking a chat closes the drawer, like the web page's switchChannel
    if (key !== PEOPLE) setPeopleTab(null);  // (Requests was for that one visit)
    // The People page and the Lounge are in no chat: new messages anywhere count as unread.
    if (key === PEOPLE || key === LOUNGE) connection.closeChat();
    else connection.openChat(key);
  }
  openChatRef.current = go;

  // A pick in the sidebar. The Lounge also joins it (like the web page's voice channel button).
  function pick(key) {
    go(key);
    if (key === LOUNGE && voice.roomName !== LOUNGE_ROOM) voice.join(LOUNGE_ROOM);
  }

  // Someone's profile, or the user menu (a long press). Like the web page, these close the drawers:
  // they go over the chat.
  function openProfile(id) {
    setDrawer(null);
    setDialog({ type: 'profile', id });
  }
  function openUserMenu(id) {
    setDrawer(null);
    setDialog({ type: 'userMenu', id });
  }

  // The user menu's Mention: "@kari " at the end of this chat's text, and the cursor there.
  function mention(user) {
    setDrafts((old) => {
      const text = old[view] ?? '';
      const space = text && !text.endsWith(' ') ? ' ' : '';
      return { ...old, [view]: `${text}${space}@${user.name} ` };
    });
    setFocusTick((n) => n + 1);
  }

  // At the start: after a switch to new JavaScript, the chat that was open (not the Lounge, which would
  // mean being in a call: then there's no switch); else the one open when the app was last closed (the
  // Lounge's page too, without joining: that takes a tap); else the first channel (the web page's way).
  // One that's gone (a group we left, a channel we may no longer see) is left by the effect below.
  // (No channel at all, which can happen to someone with a limited role: the People page.)
  useEffect(() => {
    if (view !== null || connection.lounge === null) return;  // (null: no channel list yet)
    const first = channels.find((channel) => !channel.heading)?.key ?? PEOPLE;
    const before = restored?.view;
    go((before && before !== LOUNGE ? before : lastChat()) ?? first, false);
  }, [channels, connection.lounge]);

  // New JavaScript from the server while we're open (liveUpdates.js): only switched to when nothing would
  // be lost or cut off. Not in or ringing for a call, no files waiting in any chat's tray (or on their way
  // in from a share), no popup or dialog open (a half-done edit in Settings, say).
  useLiveUpdates({
    connection,
    safe: !voice.roomName && !voice.incoming && !voice.outgoing && !share && !toTray && dialog === null
      && popup === null && Object.values(trays).every((files) => !files?.length),
    save: () => ({ view, drafts }),
  });

  // Looking at a DM with someone who's no longer a friend (removed, blocked), a group we're no
  // longer in, or a channel an admin deleted (or made private, or the Lounge for someone with a limited
  // role)? Then it's gone: off to the first channel (or People), like the web page.
  useEffect(() => {
    // (No channel or group list yet: nothing can be judged gone. "groups" comes after "friends" at connect,
    // and before it a group opened by a notification looked gone.)
    if (connection.lounge === null || !connection.groupsKnown) return;
    const first = channels.find((channel) => !channel.heading)?.key ?? PEOPLE;
    const partner = dmPartner(view, connection.me.id);
    const goneDm = partner !== null && !connection.friends.includes(partner);
    const goneGroup = view?.startsWith('g:') && !connection.groups.some((group) => group.key === view);
    const isChannel = view !== null && partner === null && !view.startsWith('g:') && view !== PEOPLE && view !== LOUNGE;
    const goneChannel = isChannel && !channels.some((channel) => channel.key === view && !channel.heading);
    const goneLounge = view === LOUNGE && !connection.lounge;
    if (goneDm || goneGroup || goneChannel || goneLounge) {
      history.current = history.current.filter((key) => key !== view);
      go(first, false);
    }
  }, [connection.friends, connection.groups, channels, connection.lounge, connection.groupsKnown]);

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

  // A notification was tapped (or started the app): go there, once the first chat is open. A message:
  // its chat, and the message (the web page's openMessage). A friend request: People → Requests. A
  // call: its chat (the server rings us again as we connect, so the popup shows); Accept answers it.
  useEffect(() => {
    if (!opened || view === null) return;
    onOpenedDone();
    const { channel, messageId, action } = opened;
    if (action === 'accept') {
      voice.acceptFromNotification(channel);
    } else if (channel === 'friends') {
      setPeopleTab({ tab: 'requests', at: Date.now() });
      go(PEOPLE);
    } else if (channel) {
      go(channel);
      if (messageId) setJumpRequest({ chat: channel, id: messageId });
    }
  }, [opened, view === null]);

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
        {view === PEOPLE || view === LOUNGE ? (
          <Text numberOfLines={1} style={styles.title}>{view === PEOPLE ? 'People' : 'Lounge'}</Text>
        ) : (
          <>
            <ChatTitle connection={connection} chatKey={view} />
            {/* Mute, search, pins (and call): the web page's #dm-header buttons, here in the top bar itself. */}
            <ChatButtons
              connection={connection} voice={voice} chatKey={view} onPopup={setPopup}
              onGroupMenu={() => setDialog({ type: 'groupMenu', key: view })}
            />
          </>
        )}
        {/* (No member list on the People page and the Lounge, like the web page.) */}
        {view === PEOPLE || view === LOUNGE ? <View style={styles.topbarButton} /> : (
          <Pressable onPress={() => setDrawer('right')} style={styles.topbarButton} hitSlop={4}>
            <Icon name="users" size={22} color={colors.text} />
          </Pressable>
        )}
      </View>
      {connection.status !== 'online' ? <Text style={styles.offline}>Reconnecting…</Text> : null}

      <View style={styles.content}>
        {/* A DM's or group's call, above its messages. */}
        {view !== PEOPLE && view !== LOUNGE && hasCallBanner(view, connection, voice)
          ? <CallBanner chatKey={view} connection={connection} voice={voice} />
          : null}
        {view === LOUNGE ? <LoungeScreen connection={connection} voice={voice} /> : null}
        {view === LOUNGE ? null : view === PEOPLE
          ? (
            <PeopleScreen
              key={peopleTab?.at ?? 'people'}
              connection={connection} onOpen={go} onProfile={openProfile} onUserMenu={openUserMenu}
              onInvite={() => setDialog({ type: 'invites' })} startTab={peopleTab?.tab}
            />
          )
          : <ChatScreen connection={connection} backRef={chatBack} shared={toTray} onSharedTaken={() => setToTray(null)} trays={trays} setTrays={setTrays} drafts={drafts} setDrafts={setDrafts} onOpenChat={go} popup={popup} setPopup={setPopup} onProfile={openProfile} onUserMenu={openUserMenu} focusTick={focusTick} jumpRequest={jumpRequest} onJumpTaken={() => setJumpRequest(null)} />}
        {/* In a call but looking at something else: the call in a corner (above a chat's text box). */}
        <CallFloat
          connection={connection} voice={voice} view={view} onOpen={go}
          bottomGap={view === PEOPLE || view === LOUNGE ? 0 : 72}
        />
      </View>

      <Drawer side="left" open={drawer === 'left'} onClose={() => setDrawer(null)}>
        <Sidebar
          connection={connection} voice={voice} view={view} onPick={pick} onPeople={() => go(PEOPLE)}
          onUserMenu={openUserMenu} onProfile={openProfile}
          onNewGroup={() => {
            setDrawer(null);  // (the web page closes the drawer too)
            setDialog({ type: 'group', key: null });
          }}
          onMe={() => setDialog({ type: 'me' })}
          settingsDot={changelog.unseen}
          notificationsMuted={isMuted(notifications.settings) || connection.myPresence === 'dnd'}
          onSeason={() => {
            setDrawer(null);
            setDialog({ type: 'season' });
          }}
          onSettings={() => {
            setDrawer(null);  // (the web page closes the drawer too)
            setDialog({ type: 'settings', page: null });
          }}
        />
      </Drawer>
      <Drawer side="right" open={drawer === 'right'} onClose={() => setDrawer(null)}>
        <Members connection={connection} view={view} onProfile={openProfile} onUserMenu={openUserMenu} />
      </Drawer>

      {dialog?.type === 'profile' ? (
        <ProfileScreen connection={connection} voice={voice} userId={dialog.id} onOpen={go} onClose={closeDialog} />
      ) : null}
      {dialog?.type === 'userMenu' ? (
        <UserMenu
          connection={connection} userId={dialog.id} onProfile={openProfile} onOpen={go} onClose={closeDialog}
          onMention={view === PEOPLE || view === LOUNGE ? null : mention}  // (only in a chat, which has a text box)
          onEditProfile={() => setDialog({ type: 'settings', page: 'profile' })}
          onBan={(id) => setDialog({ type: 'ban', id })}
          onCall={(dm) => {
            go(dm);
            voice.startCall(dm);
          }}
        />
      ) : null}
      {dialog?.type === 'me' ? (
        <MeScreen
          connection={connection} voice={voice} onClose={closeDialog}
          onOpenCall={() => go(voice.roomName === LOUNGE_ROOM ? LOUNGE : voice.roomName)}
          onEditProfile={() => {
            setDrawer(null);
            setDialog({ type: 'settings', page: 'profile' });
          }}
        />
      ) : null}
      {dialog?.type === 'settings' ? (
        <SettingsScreen
          connection={connection} voice={voice} notifications={notifications} changelog={changelog}
          page={dialog.page} onClose={closeDialog}
        />
      ) : null}
      {dialog?.type === 'season' && connection.me.season ? (
        <SeasonScreen season={connection.me.season} onClose={closeDialog} />
      ) : null}
      {dialog?.type === 'ban' && connection.users[dialog.id] ? (
        <BanDialog user={connection.users[dialog.id]} onClose={closeDialog} />
      ) : null}
      {dialog?.type === 'group' ? (
        <GroupDialog connection={connection} groupKey={dialog.key} onCreated={go} onClose={closeDialog} />
      ) : null}
      {dialog?.type === 'groupMenu' ? (
        <GroupMenu
          connection={connection} groupKey={dialog.key} onClose={closeDialog}
          onAdd={() => setDialog({ type: 'group', key: dialog.key })}
          onRename={() => setDialog({ type: 'rename', key: dialog.key })}
        />
      ) : null}
      {dialog?.type === 'rename' ? <RenameDialog connection={connection} groupKey={dialog.key} onClose={closeDialog} /> : null}
      {dialog?.type === 'invites' ? <InviteScreen onClose={closeDialog} /> : null}
      {/* Someone calling us: over everything, even another popup. */}
      <IncomingCall connection={connection} voice={voice} />
    </KeyboardAvoidingView>
  );
}

function Loading({ text }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.textMuted} size="large" />
      {text ? <Text style={styles.loadingText}>{text}</Text> : null}
    </View>
  );
}

function Screen({ share, onShareDone, opened, onOpenedDone }) {
  const connection = useConnection();
  // Calls, kept up here: this stays while we're logged in, so a call goes on whatever the screens do.
  const openChatRef = useRef(null);
  const voice = useVoice(connection, openChatRef);
  const notifications = useNotifications(connection);
  const { status, me } = connection;

  // The appearance kept with the account (in "welcome", and "appearance" after a change on any device).
  const { setAppearance } = useTheme();
  useEffect(() => {
    if (connection.appearance) setAppearance(connection.appearance);
  }, [connection.appearance]);
  if (status === 'logged-out') return <LoginScreen onLoggedIn={connection.reconnect} />;
  // Not connected yet (we don't know who we are until "welcome").
  if (me === null) return <Loading text={status === 'offline' ? "Can't reach the server, trying again…" : null} />;
  return (
    <Main
      connection={connection} voice={voice} notifications={notifications} openChatRef={openChatRef}
      share={share} onShareDone={onShareDone} opened={opened} onOpenedDone={onOpenedDone}
    />
  );
}

// The frame around everything: the safe area (see App) and the phone's status bar, in the theme's
// colours. (Its own component, inside the theme's provider, so it can read the theme.)
function Frame({ children }) {
  const styles = useStyles(makeStyles);
  const { light } = useTheme();
  return (
    <SafeAreaView style={styles.app}>
      {children}
      {/* The bar's clock and icons: dark on a light theme, light on a dark one. */}
      <StatusBar style={light ? 'dark' : 'light'} />
    </SafeAreaView>
  );
}

export default function App() {
  // The appearance (Settings → Appearance), from the copy on the phone until the server sends ours.
  // setAppearance changes it everywhere at once: everything that reads the theme draws again.
  const [appearance, setAppearanceState] = useState(loadAppearance);
  const theme = useMemo(() => ({
    ...makeTheme(appearance),
    setAppearance: (next) => {
      setAppearanceState(next);
      saveAppearance(next);  // (for the next start's first drawing)
    },
  }), [appearance]);
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
  // A tapped notification (modules/push): kept up here too, through the login and the connecting.
  const [opened, setOpened] = useState(null);
  // Android hands over the tap with the app's Activity, which this early in a cold start may not be
  // ready yet (then the answer is "none", and we'd open the first channel): so ask a few more times in
  // the first seconds. The module marks a tap as dealt with, so it's never opened twice.
  useEffect(() => {
    let stopped = false;
    (async () => {
      for (const wait of [0, 300, 1000, 2500]) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (stopped) return;
        const first = await getInitialOpen().catch(() => null);
        if (first) {
          setOpened(first);
          return;
        }
      }
    })();
    const subscription = addOpenListener(setOpened);
    return () => {
      stopped = true;
      subscription.remove();
    };
  }, []);
  // Android draws apps "edge to edge", under the status bar and the navigation bar.
  // SafeAreaView adds padding the size of those bars, so nothing ends up behind them.
  // ThemeContext.Provider hands the theme to every component inside it (useTheme, useStyles).
  return (
    <ThemeContext.Provider value={theme}>
      <SafeAreaProvider>
        <Frame>
          <Screen
            share={share} onShareDone={() => setShare(null)} opened={opened} onOpenedDone={() => setOpened(null)}
          />
          {/* A newer APK to install (release builds; the JavaScript updates itself, expo-updates). */}
          <UpdateScreen />
        </Frame>
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.bgMain },
  main: { flex: 1 },
  // #topbar: gap 4px, padding 4px, a line under it.
  topbar: {
    flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgMain,
  },
  topbarButton: { paddingHorizontal: 12, paddingVertical: 8, minWidth: 46 },
  newDot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  title: { flex: 1, fontSize: size(16), fontWeight: '600', color: colors.textStrong },
  offline: { backgroundColor: colors.red, color: colors.textStrong, textAlign: 'center', paddingVertical: 4 },
  content: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, backgroundColor: colors.bgMain },
  loadingText: { color: colors.textMuted },
});
