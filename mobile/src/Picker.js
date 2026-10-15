// The emoji and GIF pickers: the web page's phone version (chat.css under 700px), a sheet over the
// bottom 55% of the screen. Writing, it has Emoji | GIF tabs (one smiley button opens both); for a
// reaction it's emoji only.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image, Modal, Pressable, ScrollView, SectionList, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from './colors';
import { SERVER } from './config';
import { CustomEmoji } from './MessageText';

// Emoji picked lately, newest first (unicode emoji, or "custom:17"): up to 24. Kept while the app
// runs (the web page keeps it in the browser; storage on the phone comes with Settings).
let recentEmoji = [];
let lastTab = 'emoji';  // the tab used last: the smiley opens that one again, like the web page

function remember(value) {
  recentEmoji = [value, ...recentEmoji.filter((other) => other !== value)].slice(0, 24);
}

// ----- Emoji

function EmojiTab({ connection, onPick }) {
  const { emoji, emojiGroups, users, me } = connection;
  const [query, setQuery] = useState('');
  const list = useRef(null);
  const { width } = useWindowDimensions();
  // Cells at least 36 px wide, as many as fit (the web page's repeat(auto-fill, minmax(36px, 1fr))).
  const columns = Math.max(1, Math.floor((width - 16) / 36));

  // The sections: Recently used, custom emoji by whose they are (ours first), then Unicode's groups.
  // Searching: one "Search results" section, custom names first, at most 300.
  const sections = useMemo(() => {
    const customs = Object.values(emoji).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const unicode = (emojiGroups ?? []).flatMap((group) => group.emoji);
    const result = [];
    const typed = query.trim().toLowerCase();
    if (typed) {
      const found = [
        ...customs.filter((item) => item.name.toLowerCase().includes(typed)).map((item) => 'custom:' + item.id),
        ...unicode.filter(([, name]) => name.toLowerCase().includes(typed)).map(([character]) => character),
      ].slice(0, 300);
      result.push({ title: found.length ? 'Search results' : 'No emoji found', items: found });
    } else {
      const recent = recentEmoji.filter((value) => !value.startsWith('custom:') || emoji[value.slice(7)]);
      if (recent.length) result.push({ title: 'Recently used', items: recent });
      const owners = [...new Set(customs.map((item) => item.owner_id))].sort((a, b) => {
        if (a === me.id) return -1;
        if (b === me.id) return 1;
        return (users[a]?.name ?? '').localeCompare(users[b]?.name ?? '');
      });
      for (const owner of owners) {
        result.push({
          title: owner === me.id ? 'Your emoji' : `${users[owner]?.name ?? 'Someone'}'s emoji`,
          items: customs.filter((item) => item.owner_id === owner).map((item) => 'custom:' + item.id),
          custom: true,
        });
      }
      for (const group of emojiGroups ?? []) {
        result.push({ title: group.name, items: group.emoji.map(([character]) => character), group: true });
      }
    }
    // A SectionList draws rows, so each section's emoji go in rows of `columns`.
    return result.map((section) => {
      const rows = [];
      for (let i = 0; i < section.items.length; i += columns) rows.push(section.items.slice(i, i + columns));
      return { ...section, data: rows };
    });
  }, [emoji, emojiGroups, query, columns]);

  // The category bar: ⭐ for the custom emoji (if there are any), then each group's first emoji.
  // Tapping one scrolls to that section.
  function jumpTo(predicate) {
    setQuery('');
    const index = sections.findIndex(predicate);
    if (index >= 0) list.current?.scrollToLocation({ sectionIndex: index, itemIndex: 0, viewOffset: 0, animated: false });
  }

  function pick(value) {
    remember(value);
    onPick(value);
  }

  return (
    <>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search emoji"
        placeholderTextColor={colors.textMuted}
        autoCorrect={false}
      />
      {query ? null : (
        <ScrollView horizontal style={styles.categories} contentContainerStyle={styles.categoriesInside}>
          {Object.keys(emoji).length ? (
            <Pressable onPress={() => jumpTo((section) => section.custom)} style={styles.category}>
              <Text style={styles.categoryText}>⭐</Text>
            </Pressable>
          ) : null}
          {(emojiGroups ?? []).map((group) => (
            <Pressable key={group.name} onPress={() => jumpTo((section) => section.title === group.name)} style={styles.category}>
              <Text style={styles.categoryText}>{group.emoji[0][0]}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <SectionList
        ref={list}
        sections={sections}
        keyExtractor={(row, index) => row.join('') + index}
        stickySectionHeadersEnabled
        keyboardShouldPersistTaps="handled"
        style={styles.grid}
        initialNumToRender={12}
        onScrollToIndexFailed={() => {}}
        renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
        renderItem={({ item: row }) => (
          <View style={styles.row}>
            {row.map((value) => (
              <Pressable
                key={value}
                onPress={() => pick(value)}
                style={({ pressed }) => [styles.cell, { width: `${100 / columns}%` }, pressed && styles.cellPressed]}
              >
                {value.startsWith('custom:')
                  ? <CustomEmoji item={emoji[value.slice(7)]} size={28} />
                  : <Text style={styles.cellText}>{value}</Text>}
              </Pressable>
            ))}
          </View>
        )}
      />
    </>
  );
}

// ----- GIFs (GIPHY, through our server's /gifs/search)

function GifTab({ onPick }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState(null);       // the results; null while loading
  const [note, setNote] = useState('Loading…');
  const asked = useRef(0);                      // the newest search: older answers are dropped
  const timer = useRef(null);
  const { width } = useWindowDimensions();
  const columnWidth = (width - 16 - 6) / 2;     // two columns, 6px apart

  async function search(text) {
    const mine = ++asked.current;
    setNote('Loading…');
    try {
      const response = await fetch(`${SERVER}/gifs/search?q=${encodeURIComponent(text.trim())}`);
      const answer = await response.json().catch(() => ({}));
      if (mine !== asked.current) return;
      if (!response.ok) {
        setGifs([]);
        setNote(typeof answer.detail === 'string' ? answer.detail : "GIF search isn't working right now.");
        return;
      }
      setGifs(answer.gifs);
      setNote(answer.gifs.length ? '' : 'No GIFs found. Try other words?');
    } catch {
      if (mine === asked.current) setNote('Not connected, try again in a moment.');
    }
  }

  useEffect(() => {
    search('');  // trending, until something is typed
    return () => clearTimeout(timer.current);
  }, []);

  function onType(text) {
    setQuery(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(text), 400);  // 400 ms after typing stops
  }

  // Two columns, each GIF going into the shorter one so far (the web page's CSS columns do that).
  const columns = [[], []];
  const heights = [0, 0];
  for (const gif of gifs ?? []) {
    const height = (gif.height / gif.width) * columnWidth;
    const shorter = heights[0] <= heights[1] ? 0 : 1;
    columns[shorter].push({ ...gif, shownHeight: height });
    heights[shorter] += height + 6;
  }

  return (
    <>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={onType}
        onSubmitEditing={() => { clearTimeout(timer.current); search(query); }}
        placeholder="Search GIPHY"
        placeholderTextColor={colors.textMuted}
        returnKeyType="search"
      />
      <ScrollView style={styles.grid} contentContainerStyle={styles.gifColumns} keyboardShouldPersistTaps="handled">
        {note ? <Text style={styles.note}>{note}</Text> : null}
        {columns.map((column, index) => (
          <View key={index} style={{ width: columnWidth }}>
            {column.map((gif) => (
              <Pressable key={gif.id} onPress={() => onPick(gif)} style={styles.gif}>
                <Image source={{ uri: gif.preview }} style={{ width: columnWidth, height: gif.shownHeight }} accessibilityLabel={gif.title} />
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
      {/* GIPHY's terms ask for this. */}
      <Text style={styles.attribution}>Powered by GIPHY</Text>
    </>
  );
}

// ----- The sheet

// mode "insert" (writing: Emoji | GIF) or "react" (emoji only). onPickEmoji(value): a Unicode emoji
// or "custom:17". onPickGif(gif): a GIPHY result.
export default function Picker({ connection, mode, onPickEmoji, onPickGif, onClose }) {
  const [tab, setTab] = useState(mode === 'react' ? 'emoji' : lastTab);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  function switchTo(name) {
    setTab(name);
    lastTab = name;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      {/* Tapping above the sheet closes it. */}
      <Pressable style={styles.outside} onPress={onClose} />
      <View style={[styles.sheet, { height: height * 0.55 + insets.bottom, paddingBottom: insets.bottom }]}>
        {mode === 'insert' ? (
          <View style={styles.tabs}>
            {['emoji', 'gif'].map((name) => (
              <Pressable key={name} onPress={() => switchTo(name)} style={[styles.tab, tab === name && styles.tabActive]}>
                <Text style={[styles.tabText, tab === name && styles.tabTextActive]}>{name === 'emoji' ? 'Emoji' : 'GIF'}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {tab === 'emoji'
          ? <EmojiTab connection={connection} onPick={onPickEmoji} />
          : <GifTab onPick={onPickGif} />}
      </View>
    </Modal>
  );
}

// chat.css's pickers (rem as 16 px).
const styles = StyleSheet.create({
  outside: { flex: 1 },
  sheet: {
    backgroundColor: colors.bgPanel, borderTopLeftRadius: 12, borderTopRightRadius: 12,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  tabs: { flexDirection: 'row', gap: 4, paddingTop: 8, paddingHorizontal: 8 },
  tab: { flex: 1, padding: 6, borderRadius: 6, alignItems: 'center' },
  tabActive: { backgroundColor: colors.bgActive },
  tabText: { fontSize: 14.4, fontWeight: '600', color: colors.textMuted },
  tabTextActive: { color: colors.textStrong },
  search: {
    margin: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
    backgroundColor: colors.bgDarkest, color: colors.text, fontSize: 15.2,
  },
  categories: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
  categoriesInside: { paddingHorizontal: 8, paddingBottom: 6, gap: 2 },
  category: { paddingHorizontal: 4, paddingVertical: 2 },
  categoryText: { fontSize: 17.6 },
  grid: { flex: 1, paddingHorizontal: 8 },
  sectionTitle: {
    paddingTop: 8, paddingBottom: 4, fontSize: 11.2, textTransform: 'uppercase', color: colors.textMuted,
    backgroundColor: colors.bgPanel,
  },
  row: { flexDirection: 'row' },
  cell: { alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 4 },
  cellPressed: { backgroundColor: colors.bgActive },
  cellText: { fontSize: 22.4, lineHeight: 27 },
  gifColumns: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', paddingBottom: 8 },
  gif: { marginBottom: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.bgDarkest },
  note: { width: '100%', padding: 8, color: colors.textMuted, fontSize: 13.6 },
  attribution: {
    textAlign: 'right', paddingHorizontal: 8, paddingVertical: 6, fontSize: 11.2, fontWeight: 'bold',
    color: colors.textMuted, borderTopWidth: 1, borderTopColor: colors.line,
  },
});
