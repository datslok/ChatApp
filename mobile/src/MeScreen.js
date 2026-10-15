// Your own popup (the web page's #me-popup), from your panel at the bottom of the sidebar: your banner,
// picture, name, status line and what you're doing, then your status to pick: Online, Idle, Do Not
// Disturb, Invisible. Picking one tells the server, which tells all your devices ("my_presence") and
// everyone else ("users"); nothing changes here until it answers. (The call you're in comes with
// calls; Edit profile and Log out with Settings.)
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, presenceColors } from './colors';
import { Avatar } from './people';
import { Activity, Banner } from './ProfileScreen';

// The ones you can choose (server.py, PRESENCES), with the web page's names and explanations.
const PRESENCES = [
  { key: 'online', name: 'Online', help: '' },
  { key: 'idle', name: 'Idle', help: 'Shown as away' },
  { key: 'dnd', name: 'Do Not Disturb', help: 'No notifications or sounds, on any device' },
  { key: 'invisible', name: 'Invisible', help: 'You look offline, but can chat as usual' },
];

// A status dot on its own (not on a picture's corner): Invisible is a ring.
function Dot({ presence }) {
  const color = presenceColors[presence];
  return presence === 'invisible'
    ? <View style={[styles.dot, { borderWidth: 2.5, borderColor: color }]} />
    : <View style={[styles.dot, { backgroundColor: color }]} />;
}

export default function MeScreen({ connection, onClose }) {
  const { users, me, myPresence } = connection;
  const insets = useSafeAreaInsets();
  const mine = users[me.id];
  if (!mine) return null;

  function pick(presence) {
    if (presence !== myPresence) connection.setPresence(presence);
    onClose();
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      {/* The web page's backdrop here is see-through: a tap beside the popup closes it. */}
      <Pressable style={styles.backdrop} onPress={onClose} />
      {/* Just above your panel at the bottom left (64 px tall), like on the web page. */}
      <View style={[styles.popup, { bottom: insets.bottom + 64 + 8 }]}>
        <Banner user={mine} />
        <View style={styles.content}>
          <View style={styles.picture}>
            <Avatar user={mine} size={80} />
          </View>
          <Text style={styles.name}>{mine.name}</Text>
          {mine.status ? <Text style={styles.status}>{mine.status}</Text> : null}
          {mine.activity ? <Activity activity={mine.activity} style={styles.activityText} /> : null}

          <View style={styles.box}>
            <Text style={styles.heading}>Status</Text>
            {PRESENCES.map(({ key, name, help }) => (
              <Pressable
                key={key}
                onPress={() => pick(key)}
                style={({ pressed }) => [styles.option, key === myPresence && styles.chosen, pressed && styles.pressed]}
              >
                <Dot presence={key} />
                <View style={styles.optionText}>
                  <Text style={styles.optionName}>{name}</Text>
                  {help ? <Text style={styles.help}>{help}</Text> : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// chat.css's #me-popup, rem as 16 px.
const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // min(300px, 100vw - 16px) wide, a border, rounded, a shadow.
  popup: {
    position: 'absolute', left: 8, width: 300, maxWidth: '95%', overflow: 'hidden', borderWidth: 1,
    borderColor: colors.border, borderRadius: 8, backgroundColor: colors.bgPanelAlt, elevation: 12,
  },
  content: { paddingHorizontal: 14, paddingBottom: 14 },
  // The picture overlaps the banner, on the left, with a 5px ring in the popup's colour.
  picture: { alignSelf: 'flex-start', marginTop: -45, marginBottom: 8, padding: 5, borderRadius: 45, backgroundColor: colors.bgPanelAlt },
  name: { fontSize: 19.2, fontWeight: '700', color: colors.textStrong },
  status: { marginTop: 2, fontSize: 13.6, color: colors.textSoft },
  activityText: { fontSize: 13.6 },
  // #me-presence: a box, 12px above, padding 4px; its heading 0.75rem, soft.
  box: { marginTop: 12, padding: 4, borderRadius: 8, backgroundColor: colors.bgPanel },
  heading: { marginHorizontal: 6, marginVertical: 4, fontSize: 12, fontWeight: '700', color: colors.textSoft },
  // .presence-option: the dot and the words, padding 6px 10px; the chosen one highlighted.
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  chosen: { backgroundColor: colors.bgActive },
  pressed: { backgroundColor: colors.bgHover },
  dot: { width: 10, height: 10, borderRadius: 5 },
  optionText: { flex: 1 },
  optionName: { fontSize: 14.4, color: colors.text },
  help: { fontSize: 12, color: colors.textMuted },
});
