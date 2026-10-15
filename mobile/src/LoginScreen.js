// Logging in, drawn like the web page's login.html: a card in the middle with the same fields,
// button and links. The same POST /login: the server answers with the session cookie, which Android
// keeps (like a browser) and sends with the WebSocket from then on.
import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useStyles } from './theme';
import { SERVER } from './config';

export default function LoginScreen({ onLoggedIn }) {
  const styles = useStyles(makeStyles);
  // What's typed in the two boxes. A <TextInput> shows `value` and calls onChangeText with
  // every change; we store it, React redraws the box with it ("controlled input").
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);  // waiting for the server: no second tap

  async function logIn() {
    if (busy || !username || !password) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${SERVER}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        onLoggedIn();
        return;
      }
      // FastAPI puts the reason in "detail": "Wrong username or password." and the like.
      const answer = await response.json().catch(() => ({}));
      setError(answer.detail || `Couldn't log in (${response.status}).`);
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(false);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      {/* A ScrollView, so the card can scroll up above the keyboard on a small screen. */}
      <ScrollView contentContainerStyle={styles.middle} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.title}>ChatApp</Text>
          <View style={styles.field}>
            <Text style={styles.label}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"   // usernames: no capital first letter from the keyboard
              autoCorrect={false}
              autoComplete="username" // lets Android's password manager fill it in
              returnKeyType="next"
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry          // dots instead of letters
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={logIn}  // the keyboard's Enter key logs in too
            />
          </View>
          {/* Always there (empty or not), so the card doesn't jump when an error appears. */}
          <Text style={styles.error}>{error}</Text>
          <Pressable style={({ pressed }) => [styles.button, (pressed || busy) && styles.pressed]} onPress={logIn}>
            {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Log in</Text>}
          </Pressable>
          {/* These two pages are the web page's own for now: they open in the phone's browser. */}
          <Text style={styles.link} onPress={() => Linking.openURL(`${SERVER}/reset`)}>Forgot password?</Text>
          <Text style={styles.switch}>
            No account yet?{' '}
            <Text style={styles.linkButton} onPress={() => Linking.openURL(`${SERVER}/login?register`)}>Create one</Text>
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// login.html's sizes and colours.
const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  middle: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  // The card: 384px wide at most, padding 32px, radius 8px, 12px between its rows.
  card: { width: '100%', maxWidth: 384, padding: 32, borderRadius: 8, backgroundColor: colors.bgPanel, gap: 12 },
  title: { marginBottom: 8, fontSize: size(24), fontWeight: 'bold', color: '#ffffff', textAlign: 'center' },
  field: { gap: 6 },
  label: { fontSize: size(13.6), color: colors.textSoft },
  input: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  error: { minHeight: 18, color: colors.red, fontSize: size(14.4) },
  button: { padding: 10, borderRadius: 6, backgroundColor: colors.accent, alignItems: 'center' },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(16) },
  link: { textAlign: 'center', fontSize: size(14.4), color: colors.link },
  switch: { textAlign: 'center', fontSize: size(14.4), color: colors.textSoft },
  linkButton: { color: colors.link, textDecorationLine: 'underline' },
});
