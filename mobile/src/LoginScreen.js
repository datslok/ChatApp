// Logging in: the same POST /login as the web page's login.html. The server answers with the
// session cookie, which Android keeps (like a browser) and sends with the WebSocket from then on.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from './colors';
import { SERVER } from './config';

export default function LoginScreen({ onLoggedIn }) {
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
    <View style={styles.screen}>
      <Text style={styles.title}>ChatApp</Text>
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
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {/* A Pressable is a tappable area; its style can depend on whether it's being pressed. */}
      <Pressable
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        onPress={logIn}
      >
        {busy ? <ActivityIndicator color={colors.textStrong} /> : <Text style={styles.buttonText}>Log in</Text>}
      </Pressable>
    </View>
  );
}

// React Native's styles look like CSS, written as JavaScript objects with camelCase names.
// Every <View> is a flexbox column by default.
const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.bgMain },
  title: { color: colors.textStrong, fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: 32 },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase', marginBottom: 6 },
  input: {
    backgroundColor: colors.bgDarkest, color: colors.text, fontSize: 16,
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 16,
  },
  error: { color: colors.red, marginBottom: 16 },
  button: { backgroundColor: colors.accent, borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: colors.textStrong, fontSize: 16, fontWeight: 'bold' },
});
