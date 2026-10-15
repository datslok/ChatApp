// Settings → Bugs & ideas (the web page's settings.js, "bugs & ideas"): a bug report or an idea, which
// goes straight to the admins (saved on the server, emailed to every admin, and in Settings → Admin →
// Inbox). `phone: true` tells the server it came from this app, so the inbox says "Android app".
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { postJson } from './api';
import { Button, Field, Form, Help, Status, Title } from './SettingsParts';
import { useStyles, useTheme } from './theme';

const KINDS = [
  { kind: 'bug', icon: 'bug', label: 'Report a bug' },
  { kind: 'idea', icon: 'lightbulb', label: 'Suggest an idea' },
];

// A round radio button with its icon and words (the web page's <label class="checkbox">).
function Choice({ icon, label, chosen, onPress }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} style={styles.choice} accessibilityRole="radio" accessibilityState={{ checked: chosen }}>
      <View style={[styles.radio, chosen && styles.radioChosen]}>{chosen ? <View style={styles.radioDot} /> : null}</View>
      <Icon name={icon} size={18} color={colors.text} />
      <Text style={styles.choiceText}>{label}</Text>
    </Pressable>
  );
}

// A half-written report stays when Settings closes (in case that was by mistake), like the web page's.
let draft = { kind: 'bug', text: '' };

export default function FeedbackSettings() {
  const styles = useStyles(makeStyles);
  const [kind, setKind] = useState(draft.kind);
  const [text, setText] = useState(draft.text);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  draft = { kind, text };

  async function send() {
    setSending(true);  // no second copy from a double tap
    const result = await postJson('/feedback', { kind, text, phone: true });
    setSending(false);
    if (!result.ok) {
      setMessage({ text: result.error, error: true });
      return;
    }
    setText('');
    setKind('bug');
    setMessage({ text: kind === 'bug' ? 'Thanks! The bug report is sent.' : 'Thanks! Your idea is sent.' });
  }

  return (
    <View>
      <Title>Bugs & ideas</Title>
      <Form>
        <Help>Something broken, or something you'd like? It goes straight to the admins.</Help>
        <View style={styles.kinds}>
          {KINDS.map((item) => (
            <Choice key={item.kind} icon={item.icon} label={item.label} chosen={kind === item.kind} onPress={() => setKind(item.kind)} />
          ))}
        </View>
        <Field
          label="What happened, or what would you like?" value={text} onChangeText={setText} maxLength={4000} multiline
          placeholder="For a bug: what you did, what you expected, and what happened instead" style={styles.text}
        />
        <Status status={message} />
        <Button label="Send" onPress={send} disabled={sending || !text.trim()} />
      </Form>
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // #feedback-kinds: side by side, under each other when there's no room.
  kinds: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center' },
  radioChosen: { borderColor: colors.accent },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  choiceText: { color: colors.text, fontSize: size(16) },
  text: { minHeight: 140, textAlignVertical: 'top' },  // six lines' room (rows="6")
});
