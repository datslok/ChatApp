// Resetting a forgotten password, drawn like the web page's reset.html (and LoginScreen's card).
// Two steps, two forms:
//   - no token: "Forgot password?" from the login screen: your email -> POST /forgot sends a link;
//   - a token: that link, tapped in the email. Android opens it here instead of in the browser
//     (App Links: app.json's intentFilters claim /reset, App.js resetToken reads it): choose a new
//     password -> POST /reset. The server then logs the account out everywhere, this phone too, so
//     onDone takes us to the login screen.
// onBack: back to where we came from (the login screen, or the chat if the link came while logged in).
import { useEffect, useState } from 'react';
import {
  ActivityIndicator, BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useStyles } from './theme';
import { postJson } from './api';

export default function ResetScreen({ token, onBack, onDone }) {
  const styles = useStyles(makeStyles);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  // The line under the boxes: {text, kind} with kind "error" (red) or "success" (green).
  const [status, setStatus] = useState({ text: '', kind: 'error' });
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);  // the new password is saved

  // The phone's back button (or gesture) works like "Back to log in". Returning true tells Android
  // we dealt with it, so it doesn't also close the app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!finished) onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack, finished]);

  // Step 1: ask for a link. The same answer whether or not the email has an account (the server
  // doesn't tell us either), like the web page.
  async function sendLink() {
    if (busy || !email.trim()) return;
    setBusy(true);
    const answer = await postJson('/forgot', { email: email.trim() });
    setBusy(false);
    setStatus(answer.ok
      ? { text: "If that email belongs to an account, we've sent a link. Check your inbox (and spam).", kind: 'success' }
      : { text: answer.error, kind: 'error' });
  }

  // Step 2: the new password, typed twice so a typo can't lock you out.
  async function savePassword() {
    if (busy || finished || !password) return;
    if (password !== again) {
      setStatus({ text: "The two passwords don't match.", kind: 'error' });
      return;
    }
    setBusy(true);
    const answer = await postJson('/reset', { token, password });
    setBusy(false);
    if (!answer.ok) {
      setStatus({ text: answer.error, kind: 'error' });
      return;
    }
    setFinished(true);
    setStatus({ text: 'Password changed! Taking you to the login page…', kind: 'success' });
    setTimeout(onDone, 2000);  // (time to read it, as on the web page)
  }

  const button = (label, onPress) => (
    <Pressable style={({ pressed }) => [styles.button, (pressed || busy) && styles.pressed]} onPress={onPress}>
      {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView contentContainerStyle={styles.middle} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          {token ? (
            <>
              <Text style={styles.title}>Choose a new password</Text>
              <View style={styles.field}>
                <Text style={styles.label}>New password</Text>
                <TextInput
                  style={styles.input} value={password} onChangeText={setPassword}
                  secureTextEntry autoComplete="new-password" returnKeyType="next"
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>New password again</Text>
                <TextInput
                  style={styles.input} value={again} onChangeText={setAgain}
                  secureTextEntry autoComplete="new-password" returnKeyType="go" onSubmitEditing={savePassword}
                />
              </View>
              <Text style={[styles.status, styles[status.kind]]}>{status.text}</Text>
              {button('Save new password', savePassword)}
            </>
          ) : (
            <>
              <Text style={styles.title}>Forgot password?</Text>
              <Text style={styles.text}>
                Enter the email address of your account, and we'll send you a link to choose a new password.
              </Text>
              <View style={styles.field}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input} value={email} onChangeText={setEmail}
                  keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
                  returnKeyType="send" onSubmitEditing={sendLink}
                />
              </View>
              <Text style={[styles.status, styles[status.kind]]}>{status.text}</Text>
              {button('Send reset link', sendLink)}
            </>
          )}
          {finished ? null : <Text style={styles.link} onPress={onBack}>Back to log in</Text>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// reset.html's sizes, with LoginScreen's colours from the theme.
const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgMain },
  middle: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 384, padding: 32, borderRadius: 8, backgroundColor: colors.bgPanel, gap: 12 },
  title: { marginBottom: 8, fontSize: size(24), fontWeight: 'bold', color: colors.textStrong, textAlign: 'center' },
  text: { fontSize: size(14.4), lineHeight: size(20), color: colors.text },
  field: { gap: 6 },
  label: { fontSize: size(13.6), color: colors.textSoft },
  input: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  status: { minHeight: 18, fontSize: size(14.4) },
  error: { color: colors.red },
  success: { color: colors.green },
  button: { padding: 10, borderRadius: 6, backgroundColor: colors.accent, alignItems: 'center' },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(16) },
  link: { textAlign: 'center', fontSize: size(14.4), color: colors.link },
});
