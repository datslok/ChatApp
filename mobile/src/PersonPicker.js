// Choosing a person by typing their name (the web page's usePersonPicker; the chat's rule: never a
// list of everyone). Suggestions appear under the box as you type; tapping one calls onPick(person)
// and empties the box. Used by Settings → Admin (Roles' "+ Add someone", Bans, Admins).
//
// The suggestions sit in the page's flow under the box, pushing what's below down, instead of floating
// over it as on the web page: Android only passes a tap to a view inside its parent's edges (see
// SearchScreen.js), and here the parent is any row of a scrolling page.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Avatar, matchPeople } from './people';
import { useStyles, useTheme } from './theme';

// candidates: the people who may be picked (an array of users).
export default function PersonPicker({ placeholder, candidates, onPick, style }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const matches = text.trim() ? matchPeople(text, candidates) : [];

  function pick(person) {
    setText('');
    onPick(person);
  }

  return (
    <View style={style}>
      <TextInput
        style={styles.input} value={text} onChangeText={setText} placeholder={placeholder}
        placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false}
      />
      {matches.length > 0 ? (
        <View style={styles.suggestions}>
          {matches.map((person) => (
            <Pressable
              key={person.id} onPress={() => pick(person)}
              style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
            >
              <Avatar user={person} size={16} />
              <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// #settings input, and chat.css's .person-suggestions (a list with a border, radius 8px).
const makeStyles = (colors, size) => StyleSheet.create({
  input: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  suggestions: {
    marginTop: 4, padding: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.bgPanelAlt,
  },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 4 },
  pressed: { backgroundColor: colors.bgHover },
  name: { flexShrink: 1, color: colors.text, fontSize: size(14.4) },
});
