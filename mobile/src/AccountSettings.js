// Settings → My Account (the web page's settings.js): your username, email and password. Each change
// needs your password, so someone at your unlocked phone can't take the account over; the server
// checks it (and everything else) and says what's wrong in words we show as they are.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getJson, postJson } from './api';
import { Button, Field, Form, Heading, Status, Title } from './SettingsParts';
import { useStyles } from './theme';

export default function AccountSettings() {
  const styles = useStyles(makeStyles);
  // From /me (the same as the web page asks): {username, email, pending_email, ...}. null: on its way.
  const [me, setMe] = useState(null);
  useEffect(() => {
    getJson('/me').then((result) => result.ok && setMe(result.data));
  }, []);

  // Each form's boxes and status line.
  const [username, setUsername] = useState({ name: '', password: '', status: null });
  const [email, setEmail] = useState({ address: '', password: '', status: null });
  const [password, setPassword] = useState({ current: '', next: '', again: '', status: null });

  async function changeUsername() {
    const result = await postJson('/settings/username', { username: username.name, password: username.password });
    if (!result.ok) {
      setUsername((old) => ({ ...old, status: { text: result.error, error: true } }));
      return;
    }
    setMe((old) => ({ ...old, username: result.data.username }));
    setUsername({ name: '', password: '', status: { text: 'Username changed.' } });
  }

  async function changeEmail() {
    const result = await postJson('/settings/email', { email: email.address, password: email.password });
    if (!result.ok) {
      setEmail((old) => ({ ...old, status: { text: result.error, error: true } }));
      return;
    }
    // A new address only counts once the link sent to it is clicked: until then it's "pending".
    setMe((old) => ({ ...old, email: result.data.email, pending_email: result.data.pending }));
    setEmail({
      address: '', password: '',
      status: {
        text: result.data.pending
          ? 'We sent a link to the new address: your email changes when you click it.'
          : "That's already your email.",
      },
    });
  }

  async function resend() {
    const result = await postJson('/verify/resend');
    setEmail((old) => ({
      ...old,
      status: result.ok ? { text: 'Sent again. Check that inbox, and its spam folder.' } : { text: result.error, error: true },
    }));
  }

  async function cancelPending() {
    const result = await postJson('/settings/email/cancel');
    if (!result.ok) {
      setEmail((old) => ({ ...old, status: { text: result.error, error: true } }));
      return;
    }
    setMe((old) => ({ ...old, pending_email: null }));
    setEmail((old) => ({ ...old, status: { text: 'Cancelled: your email stays as it is.' } }));
  }

  async function changePassword() {
    if (password.next !== password.again) {
      setPassword((old) => ({ ...old, status: { text: "The two new passwords don't match.", error: true } }));
      return;
    }
    const result = await postJson('/settings/password', { current_password: password.current, new_password: password.next });
    if (!result.ok) {
      setPassword((old) => ({ ...old, status: { text: result.error, error: true } }));
      return;
    }
    setPassword({ current: '', next: '', again: '', status: { text: 'Password changed. Your other devices have been logged out.' } });
  }

  // Text boxes for words people type exactly: no capitals or corrections added by the keyboard.
  const exact = { autoCapitalize: 'none', autoCorrect: false };

  return (
    <View>
      <Title>My Account</Title>

      <Heading>Username</Heading>
      <Form>
        <Text style={styles.current}>Current: <Text style={styles.strong}>{me?.username ?? '…'}</Text></Text>
        <Field
          label="New username" value={username.name} {...exact} autoComplete="username"
          onChangeText={(name) => setUsername((old) => ({ ...old, name }))}
        />
        <Field
          label="Your password (to confirm it's you)" value={username.password} secureTextEntry {...exact}
          autoComplete="current-password" onChangeText={(text) => setUsername((old) => ({ ...old, password: text }))}
        />
        <Status status={username.status} />
        <Button label="Change username" onPress={changeUsername} disabled={!username.name || !username.password} />
      </Form>

      <Heading>Email</Heading>
      <Form>
        <Text style={styles.current}>Current: <Text style={styles.strong}>{me ? me.email || 'none yet' : '…'}</Text></Text>
        {/* A new address waiting for its link to be clicked. */}
        {me?.pending_email ? (
          <View style={styles.pending}>
            <Text style={styles.current}>
              Waiting for you to verify <Text style={styles.strong}>{me.pending_email}</Text>: click the link we sent
              there. Until then, your current address stays.
            </Text>
            <View style={styles.row}>
              <Button label="Send again" secondary small onPress={resend} />
              <Button label="Cancel" secondary small onPress={cancelPending} />
            </View>
          </View>
        ) : null}
        <Field
          label="New email" value={email.address} keyboardType="email-address" {...exact} autoComplete="email"
          onChangeText={(address) => setEmail((old) => ({ ...old, address }))}
        />
        <Field
          label="Your password (to confirm it's you)" value={email.password} secureTextEntry {...exact}
          autoComplete="current-password" onChangeText={(text) => setEmail((old) => ({ ...old, password: text }))}
        />
        <Status status={email.status} />
        <Button label="Save email" onPress={changeEmail} disabled={!email.address || !email.password} />
      </Form>

      <Heading>Password</Heading>
      <Form>
        <Field
          label="Current password" value={password.current} secureTextEntry {...exact} autoComplete="current-password"
          onChangeText={(current) => setPassword((old) => ({ ...old, current }))}
        />
        <Field
          label="New password" value={password.next} secureTextEntry {...exact} autoComplete="new-password"
          onChangeText={(next) => setPassword((old) => ({ ...old, next }))}
        />
        <Field
          label="New password again" value={password.again} secureTextEntry {...exact} autoComplete="new-password"
          onChangeText={(again) => setPassword((old) => ({ ...old, again }))}
        />
        <Status status={password.status} />
        <Button
          label="Change password" onPress={changePassword}
          disabled={!password.current || !password.next || !password.again}
        />
      </Form>
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  current: { fontSize: size(16), color: colors.text },
  strong: { fontWeight: '700' },
  pending: { gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
});
