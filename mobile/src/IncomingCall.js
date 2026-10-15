// "kari is calling…" with Accept and Decline (the web page's #incoming-call): a box at the top of the
// screen, over everything, while a call rings for us (voice.incoming). In a group: "kari · the group".
// Android's back button declines.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { Avatar } from './people';
import { groupName } from './chats';
import { useStyles } from './theme';

export default function IncomingCall({ connection, voice }) {
  const styles = useStyles(makeStyles);
  const call = voice.incoming;
  if (!call) return null;
  const caller = connection.users[call.from];
  const group = connection.groups.find((g) => g.key === call.channel);
  const who = group ? `${call.name} · ${groupName(group, connection.users, connection.me.id)}` : call.name;
  return (
    <Modal transparent animationType="fade" onRequestClose={voice.decline} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.box}>
          <Avatar user={caller} name={call.name} size={80} />
          <Text style={styles.text}><Text style={styles.name}>{who}</Text> is calling…</Text>
          <View style={styles.buttons}>
            <Pressable onPress={voice.accept} style={({ pressed }) => [styles.button, styles.accept, pressed && styles.dim]}>
              <Icon name="phone" size={18} color="#ffffff" />
              <Text style={styles.buttonText}>Accept</Text>
            </Pressable>
            <Pressable onPress={voice.decline} style={({ pressed }) => [styles.button, styles.decline, pressed && styles.dim]}>
              <Text style={styles.buttonText}>Decline</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // ::backdrop: the screen behind it a little darker. The box 24px from the top (under the status bar).
  backdrop: { flex: 1, alignItems: 'center', paddingTop: 64, paddingHorizontal: 16, backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  box: {
    alignItems: 'center', gap: 14, paddingVertical: 20, paddingHorizontal: 24, borderRadius: 12,
    backgroundColor: colors.bgPanel, elevation: 12,
  },
  text: { color: colors.text, fontSize: size(16), textAlign: 'center' },
  name: { fontWeight: '700', color: colors.textStrong },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  accept: { backgroundColor: colors.buttonGreen },
  decline: { backgroundColor: colors.buttonRed },
  buttonText: { color: '#ffffff', fontSize: size(15.2) },
  dim: { opacity: 0.8 },
});
