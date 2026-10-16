// "Check your inbox": a new account that hasn't clicked its email's link yet (the web page's
// static/verify.html). Until then the server treats it as logged out everywhere but here (server.py,
// "Email verification"), so without this screen the app just fell back to an empty login screen.
// Send again, change a mistyped address, or log out; and every 5 seconds we ask whether the link has
// been clicked (on this phone or anywhere else), then on to the chat.
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getJson, postJson } from './api';
import { useStyles } from './theme';

// email: the address the link went to. onVerified: clicked, on to the chat. onLogOut: back to logging in.
export default function VerifyScreen({ email: firstEmail, onVerified, onLogOut }) {
  const styles = useStyles(makeStyles);
  const [email, setEmail] = useState(firstEmail);
  const [changing, setChanging] = useState(false);  // "Wrong address?" opened
  const [newEmail, setNewEmail] = useState('');
  const [status, setStatus] = useState({ text: '', error: false });

  useEffect(() => {
    const timer = setInterval(async () => {
      const answer = await getJson('/verify/status');
      if (answer.ok && answer.data.verified) onVerified();
    }, 5000);
    return () => clearInterval(timer);  // (gone from the screen: stop asking)
  }, []);

  async function resend() {
    const answer = await postJson('/verify/resend');
    setStatus(answer.ok ? { text: 'Sent! Check your inbox, and the spam folder.', error: false } : { text: answer.error, error: true });
  }

  async function change() {
    const answer = await postJson('/verify/change', { email: newEmail });
    if (!answer.ok) {
      setStatus({ text: answer.error, error: true });
      return;
    }
    setEmail(answer.data.email);
    setNewEmail('');
    setChanging(false);
    setStatus({ text: 'Sent!', error: false });
  }

  async function logOut() {
    await postJson('/logout');
    onLogOut();
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView contentContainerStyle={styles.middle} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.title}>Check your inbox</Text>
          <Text style={styles.message}>
            We sent a link to <Text style={styles.strong}>{email}</Text>. Click it to finish making your account.
          </Text>
          <Pressable style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.pressed]} onPress={resend}>
            <Text style={styles.buttonText}>Send again</Text>
          </Pressable>
          {/* The web page's <details>: a link that folds out the form. */}
          <Text style={styles.link} onPress={() => setChanging(!changing)}>Wrong address? Change it</Text>
          {changing ? (
            <>
              <TextInput
                style={styles.input} value={newEmail} onChangeText={setNewEmail} placeholder="Your email address"
                placeholderTextColor={styles.placeholder.color} autoCapitalize="none" autoCorrect={false}
                autoComplete="email" keyboardType="email-address" returnKeyType="send" onSubmitEditing={change}
              />
              <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={change}>
                <Text style={styles.buttonText}>Send the link there</Text>
              </Pressable>
            </>
          ) : null}
          <Text style={[styles.status, status.error && styles.error]}>{status.text}</Text>
          <Text style={styles.link} onPress={logOut}>Log out</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// verify.html's look (the same card as the login screen's).
const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  middle: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 400, padding: 32, borderRadius: 8, backgroundColor: colors.bgPanel, gap: 12 },
  title: { fontSize: size(24), fontWeight: 'bold', color: colors.textStrong, textAlign: 'center' },
  message: { fontSize: size(16), lineHeight: size(24), color: colors.text, textAlign: 'center' },
  strong: { color: colors.textStrong, fontWeight: 'bold' },
  input: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  placeholder: { color: colors.textMuted },
  button: { padding: 10, borderRadius: 6, backgroundColor: colors.accent, alignItems: 'center' },
  secondary: { backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(16) },
  link: { textAlign: 'center', fontSize: size(14.4), color: colors.link },
  status: { minHeight: 18, textAlign: 'center', fontSize: size(14.4), color: colors.textSoft },
  error: { color: colors.red },
});
