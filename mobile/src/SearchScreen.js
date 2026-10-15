// 🔍 in the chat's bar (the web page's "Search"): words to find, where (this chat or everywhere)
// and from whom (anyone, or one person picked by typing their name). The server searches its
// full-text index, only in chats we can see, and answers with the 50 newest matches. It searches
// as you type, 300 ms after the last letter, so not every letter sends a search.
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Icon from './Icon';
import { CardButton, MessageCard, Popup, styles as cardStyles, useFocusSoon } from './MessageCard';
import { chatLabel } from './chats';
import { colors } from './colors';
import { Avatar } from './people';

// What was searched last time, so it's still there when the popup opens again (like the web page,
// whose popup keeps its words). Outside the component: the component itself goes when it closes.
const last = { query: '', where: 'here', fromId: null };

// The person picker's suggestions (the web page's matchPeople): names starting with what's typed
// first, then names containing it; at most 8.
function matchPeople(typed, people) {
  const query = typed.trim().toLowerCase();
  const name = (person) => person.name.toLowerCase();
  return [
    ...people.filter((person) => name(person).startsWith(query)),
    ...people.filter((person) => !name(person).startsWith(query) && name(person).includes(query)),
  ].slice(0, 8);
}

// onJump(chat, messageId): close this and go to the message (in another chat, too).
export default function SearchScreen({ connection, onJump, onClose }) {
  const { users, current, searchResults } = connection;
  const [query, setQuery] = useState(last.query);
  const [where, setWhere] = useState(last.where);  // "here" or "all"
  // "From": the picked person's id (null: anyone), and what's in its box. (An account that's gone
  // since last time: anyone.)
  const [fromId, setFromId] = useState(users[last.fromId] ? last.fromId : null);
  const [fromText, setFromText] = useState(users[last.fromId]?.name ?? '');
  const [matches, setMatches] = useState([]);     // the person suggestions under "From"
  const [pickerTop, setPickerTop] = useState(0);  // where they go: just under "From"
  const [ask, setAsk] = useState(null);  // our newest search's number (null: nothing to search for)
  const timer = useRef(null);
  const wordsBox = useRef(null);
  useFocusSoon(wordsBox);  // the keyboard, ready for the words

  // Search now, with these. (Passed in: a value set with setQuery a moment ago isn't in the
  // variable `query` until the next drawing.) Nothing to search for: no results, and a hint.
  function runSearch(words = query, place = where, from = fromId) {
    clearTimeout(timer.current);
    Object.assign(last, { query: words, where: place, fromId: from });
    if (!words.trim() && from === null) {
      setAsk(null);
      return;
    }
    setAsk(connection.search(words.trim(), place === 'here' ? current : null, from));
  }

  // When it opens: last time's search again (there may be new messages since).
  useEffect(() => {
    runSearch();
    return () => clearTimeout(timer.current);
  }, []);

  function onType(text) {
    setQuery(text);
    last.query = text;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(text), 300);  // 300 ms after the last key
  }

  function pickWhere(place) {
    setWhere(place);
    runSearch(query, place);
  }

  // Typing in "From": suggestions, and who it is: anyone, unless the text is exactly someone's name.
  function onTypeFrom(text) {
    setFromText(text);
    const typed = text.trim();
    const people = Object.values(users);
    setMatches(typed ? matchPeople(typed, people) : []);
    const exact = people.find((person) => person.name.toLowerCase() === typed.toLowerCase());
    const id = exact ? exact.id : null;
    if (id !== fromId) {
      setFromId(id);
      runSearch(query, where, id);
    }
  }

  // A person picked (or null: anyone again, the ×).
  function pickFrom(person) {
    setMatches([]);
    setFromText(person?.name ?? '');
    setFromId(person?.id ?? null);
    runSearch(query, where, person?.id ?? null);
  }

  // Only our newest search's answer counts.
  const results = ask !== null && searchResults?.ask === ask ? searchResults.results : null;
  let statusText = '';
  if (ask === null) statusText = 'Type the words to find, or pick a person.';
  else if (results === null) statusText = 'Searching…';
  else if (results.length === 0) statusText = 'Nothing found.';
  else if (results.length >= 50) statusText = 'The 50 newest matches:';

  // Where the "From" row ends, inside the popup: the suggestions go 4px under it.
  function measureFilters(event) {
    const { y, height } = event.nativeEvent.layout;
    setPickerTop(y + height + 4);
  }

  return (
    <Popup icon="search" title="Search" onClose={onClose}>
      <TextInput
        ref={wordsBox}
        style={styles.input}
        value={query}
        onChangeText={onType}
        onSubmitEditing={() => runSearch()}  // Enter: search now
        placeholder="Words to find"
        placeholderTextColor={colors.textMuted}
        maxLength={200}
        selectTextOnFocus  // the words from last time, selected: typing replaces them
        returnKeyType="search"
      />
      {/* "This chat / Everywhere" (the web page's drop-down; two buttons suit a phone better), and "From". */}
      <View style={styles.filters} onLayout={measureFilters}>
        <View style={styles.where}>
          {[['here', 'This chat'], ['all', 'Everywhere']].map(([place, label]) => (
            <Pressable key={place} onPress={() => pickWhere(place)} style={[styles.whereButton, where === place && styles.whereChosen]}>
              <Text style={[styles.whereText, where === place && styles.whereTextChosen]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.from}>
          <TextInput
            style={[styles.input, styles.fromInput]}
            value={fromText}
            onChangeText={onTypeFrom}
            onBlur={() => setTimeout(() => setMatches([]), 200)}  // (a moment later: a tap on a suggestion first)
            placeholder="From anyone"
            placeholderTextColor={colors.textMuted}
          />
          {fromText ? (
            <Pressable onPress={() => pickFrom(null)} hitSlop={10} style={styles.fromClear} accessibilityLabel="From anyone">
              <Icon name="x" size={16} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {statusText ? <Text style={[cardStyles.empty, styles.status]}>{statusText}</Text> : null}
      {results?.length ? (
        <ScrollView style={cardStyles.list} contentContainerStyle={cardStyles.listInside} keyboardShouldPersistTaps="handled">
          {results.map((message) => (
            <MessageCard
              key={message.id} message={message} connection={connection}
              where={where === 'all' ? chatLabel(message.channel, connection) : null}
            >
              <CardButton label="Jump" onPress={() => onJump(message.channel, message.id)} />
            </MessageCard>
          ))}
        </ScrollView>
      ) : null}

      {/* The suggestions (the web page's .person-suggestions), over the results, under "From". They
          belong to the popup itself, not to the "From" box: Android only passes on a tap to a view
          inside its parent's edges, and these hang below the box. */}
      {matches.length > 0 ? (
        <View style={[styles.suggestions, { top: pickerTop }]}>
          {matches.map((person) => (
            <Pressable
              key={person.id}
              onPress={() => pickFrom(person)}
              style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
            >
              <Avatar user={person} size={16} />
              <Text style={styles.suggestionName} numberOfLines={1}>{person.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Popup>
  );
}

// chat.css's #search-form and .person-suggestions.
const styles = StyleSheet.create({
  // The boxes: padding 8px 10px, radius 6px, the darkest background, 0.95rem.
  input: {
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: 15.2,
  },
  filters: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 10 },
  where: { flexDirection: 'row', padding: 2, borderRadius: 6, backgroundColor: colors.bgDarkest },
  whereButton: { justifyContent: 'center', paddingHorizontal: 10, borderRadius: 5 },
  whereChosen: { backgroundColor: colors.bgActive },
  whereText: { fontSize: 13.6, color: colors.textMuted },
  whereTextChosen: { color: colors.textStrong },
  from: { flex: 1, minWidth: 0, justifyContent: 'center' },
  fromInput: { paddingRight: 28 },  // room for the ×
  fromClear: { position: 'absolute', right: 8 },
  status: { marginBottom: 10 },
  // A list over the results: padding 4px, a border, radius 8px.
  suggestions: {
    position: 'absolute', left: 20, right: 20, zIndex: 5, elevation: 5, padding: 4,
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.bgPanelAlt,
  },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 4 },
  suggestionPressed: { backgroundColor: colors.bgHover },
  suggestionName: { flexShrink: 1, color: colors.text, fontSize: 14.4 },
});
