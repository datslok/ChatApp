// A DM's or group's info (the web page's chat info panel, chat-info.js): a tap on its name in the top bar
// opens it. Five tabs: Members (the right drawer's list), Media (pictures and videos in a grid of squares),
// Pins (the pinned messages, as in the 📌 popup), Links and Files. The last three come from the server
// ({"type": "chat_info"}, server.py "Chat info") 50 messages at a time, newest first; scrolling to the end
// asks for the next 50. (Phone reason for a whole screen instead of the web page's side panel: no room.)
// The layout is Settings' on a phone: a row of tabs along the top that scrolls sideways, × at its end.
import { useEffect, useRef, useState } from 'react';
import { FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import ImageViewer from './ImageViewer';
import Members from './Members';
import { CardButton, MessageCard } from './MessageCard';
import { FileAttachment, openLink } from './MessageText';
import VideoScreen from './VideoScreen';
import { SERVER } from './config';
import { clock, dayName } from './time';
import { useStyles, useTheme } from './theme';

const TABS = [['members', 'Members'], ['media', 'Media'], ['pins', 'Pins'], ['links', 'Links'], ['files', 'Files']];

const isMedia = (file) => file.image || file.video;

const EMPTY = {
  media: 'No pictures or videos here yet.',
  // (The web page says "Hover over a message"; here it's a long press.)
  pins: 'Nothing pinned here yet. Press and hold a message and choose Pin to pin it.',
  links: 'No links here yet.',
  files: 'No files here yet.',
};

// chatKey: the DM or group. onJump(id): close this and go to that message. onProfile(id), onUserMenu(id):
// a member was tapped or long-pressed (App.js opens those over this screen).
export default function ChatInfoScreen({ connection, chatKey, onJump, onClose, onProfile, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState('members');
  return (
    <Modal animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.top}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
            {TABS.map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setTab(key)}
                style={({ pressed }) => [styles.tab, tab === key && styles.tabChosen, pressed && tab !== key && styles.tabPressed]}
              >
                <Text style={[styles.tabText, tab === key && styles.tabTextChosen]}>{label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable onPress={onClose} hitSlop={8} style={styles.close} accessibilityLabel="Close">
            <Icon name="x" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        {tab === 'members' ? <Members connection={connection} view={chatKey} onProfile={onProfile} onUserMenu={onUserMenu} /> : null}
        {tab === 'pins' ? <PinsTab connection={connection} onJump={onJump} onUserMenu={onUserMenu} /> : null}
        {/* key: each tab its own list, starting empty (and FlatList can't change numColumns in place). */}
        {tab === 'media' || tab === 'links' || tab === 'files'
          ? <ListTab key={tab} tab={tab} connection={connection} onJump={onJump} onUserMenu={onUserMenu} />
          : null}
      </View>
    </Modal>
  );
}

// The pinned messages: the 📌 popup's cards (PinsScreen.js), in this screen.
function PinsTab({ connection, onJump, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const { pins } = connection;
  // Asked when the tab opens; connection.js asks again when a pin changes meanwhile.
  useEffect(() => {
    connection.openPins();
    return connection.closePins;
  }, []);
  if (pins === null || pins.length === 0) return <Text style={styles.empty}>{pins === null ? 'Loading…' : EMPTY.pins}</Text>;
  return (
    <FlatList
      data={pins}
      keyExtractor={(message) => String(message.id)}
      contentContainerStyle={styles.cards}
      renderItem={({ item: message }) => (
        <MessageCard message={message} connection={connection} onUserMenu={onUserMenu}>
          <CardButton label="Jump" onPress={() => onJump(message.id)} />
          <CardButton label="Unpin" secondary onPress={() => connection.pin(message.id, false)} />
        </MessageCard>
      )}
    />
  );
}

// Media, Links or Files: the server's batches, kept up to date while open.
function ListTab({ tab, connection, onJump, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const [items, setItems] = useState(null);  // the messages shown, newest first; null: the first batch is on its way
  // Where the next batch starts (the server's "oldest"), whether there may be more, the `before` of the
  // question on its way (undefined: none): refs, as the watcher below is made once and reads them later.
  const paging = useRef({ oldest: null, more: false, asked: undefined });
  const itemsRef = useRef([]);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;  // (the newest, for the watcher: blocked people change)

  function ask(before) {
    paging.current.asked = before;
    connectionRef.current.askChatInfo(tab, before);
  }
  function reload() {
    setItems(null);
    ask(null);
  }

  useEffect(() => {
    ask(null);
    return connection.watchChatInfo({
      batch(data) {
        // Only the answer we wait for (not one for another tab, or one a reload made old).
        if (data.tab !== tab || data.before !== paging.current.asked) return;
        paging.current = { oldest: data.oldest, more: data.more, asked: undefined };
        // Not from people we blocked (their messages are hidden in the chat too, behind Show).
        const fresh = data.items.filter((message) => !connectionRef.current.blocked.includes(message.user_id));
        itemsRef.current = data.before === null ? fresh : [...itemsRef.current, ...fresh];
        setItems(itemsRef.current);
      },
      // Something changed in the chat: ask again if it touches this tab (the web page's chatInfoNews).
      news(kind, data) {
        const shown = itemsRef.current.some((message) => message.id === data.message_id);
        const files = kind === 'message' ? data.files : [];
        const affected = {
          media: files.some(isMedia) || (kind === 'deleted' && shown),
          files: files.some((file) => !isMedia(file)) || (kind === 'deleted' && shown),
          links: (kind === 'message' && /https?:\/\//.test(data.text ?? '')) || kind === 'edited' || kind === 'preview'
            || (kind === 'deleted' && shown),
        };
        if (affected[tab]) reload();
      },
    });
  }, []);

  // Near the end of the list: the next batch, if there is one and none is on its way.
  function more() {
    if (paging.current.more && paging.current.asked === undefined) ask(paging.current.oldest);
  }

  if (items === null || items.length === 0) {
    return <Text style={styles.empty}>{items === null ? 'Loading…' : EMPTY[tab]}</Text>;
  }
  if (tab === 'media') {
    // A square per picture or video (a message can have several, and other files too).
    const tiles = items.flatMap((message) => message.files.filter(isMedia).map((file) => ({ file, message })));
    return (
      <FlatList
        data={tiles}
        numColumns={3}
        keyExtractor={(tile) => tile.file.id}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.gridRow}
        onEndReached={more}
        onEndReachedThreshold={1}
        renderItem={({ item }) => <MediaTile file={item.file} message={item.message} onJump={onJump} />}
      />
    );
  }
  // Links: a row per link (a message can have several); Files: a row per file (that too).
  const rows = tab === 'links'
    ? items.flatMap((message) => message.links.map((url, index) => ({ key: `${message.id}:${index}`, message, url, index })))
    : items.flatMap((message) => message.files.filter((file) => !isMedia(file)).map((file) => ({ key: file.id, message, file })));
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      contentContainerStyle={styles.rows}
      onEndReached={more}
      onEndReachedThreshold={1}
      renderItem={({ item: row }) => (
        <View style={styles.row}>
          {tab === 'links'
            ? <LinkRow message={row.message} url={row.url} index={row.index} />
            : (
              <FileAttachment
                file={row.file}
                sender={row.message.user_id === connection.me.id ? null : row.message.name}
              />
            )}
          <Meta message={row.message} onJump={onJump} onUserMenu={onUserMenu} />
        </View>
      )}
    />
  );
}

// A picture, cut to a square, or a video's square with ▶ (phone reason: no first frame, as a player per
// square would be heavy). A tap opens it full screen, with Jump.
function MediaTile({ file, message, onJump }) {
  const styles = useStyles(makeStyles);
  const screen = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const side = (screen.width - 16 * 2 - 4 * 2) / 3;  // three a row: the screen less the padding and gaps
  const jump = () => {
    setOpen(false);
    onJump(message.id);
  };
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={({ pressed }) => [styles.tile, { width: side, height: side }, pressed && styles.tilePressed]}>
        {file.video ? (
          <Icon name="play" size={32} color="#ffffff" />
        ) : (
          // resizeMethod "resize": decoded at about the square's size, not the photo's (MessageText.js, FittedImage).
          <Image
            source={{ uri: `${SERVER}/uploads/${encodeURIComponent(file.id)}` }}
            style={{ width: side, height: side }} resizeMode="cover" resizeMethod="resize"
          />
        )}
      </Pressable>
      {open && file.video ? <VideoScreen path={`/uploads/${encodeURIComponent(file.id)}`} onClose={() => setOpen(false)} onJump={jump} /> : null}
      {open && !file.video ? <ImageViewer files={[file]} onClose={() => setOpen(false)} onJump={jump} /> : null}
    </>
  );
}

// One link: the preview card's site and title for a message's first link (the server only previews the
// first one), else its host name and the address. A tap opens it in the browser.
function LinkRow({ message, url, index }) {
  const styles = useStyles(makeStyles);
  const preview = index === 0 ? message.preview : null;
  let site = preview?.site ?? '';
  if (!site) {
    const match = url.match(/^https?:\/\/([^/?#]+)/);  // (the host name: React Native's URL can't read it)
    site = match ? match[1] : '';
  }
  return (
    <>
      {site ? <Text style={styles.site}>{site}</Text> : null}
      <Text style={styles.link} onPress={() => openLink(url)}>{preview?.title || url}</Text>
    </>
  );
}

// Under each row: who sent it, when, and Jump. A long press on the name: the user menu.
function Meta({ message, onJump, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const sent = new Date(message.sent_at);
  return (
    <View style={styles.meta}>
      <Text
        style={styles.who} numberOfLines={1}
        onLongPress={message.user_id ? () => onUserMenu(message.user_id) : undefined}
      >
        {message.name} · {dayName(sent)} at {clock(sent)}
      </Text>
      <Pressable onPress={() => onJump(message.id)} style={({ pressed }) => [styles.jump, pressed && styles.tilePressed]}>
        <Text style={styles.jumpText}>Jump</Text>
      </Pressable>
    </View>
  );
}

// chat.css's chat info panel, with Settings' tab row on a phone (SettingsScreen.js), rem as 16 px.
const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgPanel },
  top: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgPanelAlt },
  tabs: { padding: 8, gap: 2 },
  tab: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 4 },
  tabChosen: { backgroundColor: colors.bgActive },
  tabPressed: { backgroundColor: colors.bgHoverDim },
  tabText: { fontSize: size(15.2), color: colors.textSoft },
  tabTextChosen: { color: colors.textStrong },
  close: { paddingHorizontal: 14, paddingVertical: 8 },
  empty: { padding: 16, color: colors.textMuted, fontSize: size(14) },
  cards: { padding: 16, gap: 8 },
  // .media-grid: three squares a row, 4px apart.
  grid: { padding: 16, gap: 4 },
  gridRow: { gap: 4 },
  tile: {
    borderRadius: 6, overflow: 'hidden', backgroundColor: colors.bgNeutral, alignItems: 'center', justifyContent: 'center',
  },
  tilePressed: { opacity: 0.8 },
  // .info-row: a line between rows.
  rows: { paddingHorizontal: 16, paddingBottom: 16 },
  row: { gap: 4, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, alignItems: 'flex-start' },
  site: { fontSize: size(12), color: colors.textMuted },
  link: { fontSize: size(16), color: colors.link },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  who: { flex: 1, fontSize: size(12), color: colors.textMuted },
  jump: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.bgNeutral },
  jumpText: { fontSize: size(13.6), color: colors.text },
});
