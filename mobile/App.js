// The whole app: one connection to the server, and whichever screen fits what it says.
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ChannelsScreen from './src/ChannelsScreen';
import ChatScreen from './src/ChatScreen';
import LoginScreen from './src/LoginScreen';
import { colors } from './src/colors';
import { useConnection } from './src/connection';

function Screen() {
  const connection = useConnection();
  const { status, me, current } = connection;

  if (status === 'logged-out') {
    return <LoginScreen onLoggedIn={connection.reconnect} />;
  }
  if (me === null) {
    // Not connected yet this time (we don't know who we are until "welcome").
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.textMuted} size="large" />
        {status === 'offline' ? <Text style={styles.loadingText}>Can't reach the server, trying again…</Text> : null}
      </View>
    );
  }
  if (current !== null) {
    return <ChatScreen connection={connection} />;
  }
  return (
    <View style={styles.list}>
      <View style={styles.header}>
        <Text style={styles.title}>ChatApp</Text>
        <Text style={styles.me}>{me.username}</Text>
      </View>
      {status !== 'online' ? <Text style={styles.offline}>Reconnecting…</Text> : null}
      <ChannelsScreen connection={connection} />
    </View>
  );
}

export default function App() {
  // Android draws apps "edge to edge", under the status bar and the navigation bar.
  // SafeAreaView adds padding the size of those bars, so nothing ends up behind them.
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <Screen />
        <StatusBar style="light" />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.bgPanel },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, backgroundColor: colors.bgMain },
  loadingText: { color: colors.textMuted },
  list: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.bgDarkest,
  },
  title: { color: colors.textStrong, fontSize: 20, fontWeight: 'bold' },
  me: { color: colors.textMuted },
  offline: { backgroundColor: colors.red, color: colors.textStrong, textAlign: 'center', paddingVertical: 4 },
});
