// Someone's profile (the web page's #profile popup): their banner, big picture, name with its tags,
// roles, what they're doing, their status line and bio, and the friend buttons. Opened by tapping a
// picture or name (App.js keeps which one is open). It redraws by itself when "users" changes, so a
// new status or an accepted request shows at once.
import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import { letterColors, useStyles, useTheme } from './theme';
import { SERVER } from './config';
import { friendButtons } from './friends';
import { Avatar, BotBadge, activityText } from './people';
import Slider from './Slider';

// The icons before an activity (the web page's ACTIVITY_ICONS).
const ACTIVITY_ICONS = { playing: 'gamepad-2', listening: 'music', using: 'monitor' };

// How long it's been going on, from "since" (seconds): "for 23 min", "for 2 h 5 min".
export function activityDuration(activity) {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - activity.since) / 60));
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `for ${minutes} min` : `for ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// The banner along the top: their picture from /banners/, or a strip in their own colour (3 : 1).
export function Banner({ user }) {
  const styles = useStyles(makeStyles);
  if (user.banner) {
    return <Image source={{ uri: `${SERVER}/banners/${encodeURIComponent(user.banner)}` }} style={styles.banner} />;
  }
  return <View style={[styles.banner, { backgroundColor: letterColors[user.id % letterColors.length] }]} />;
}

// "🎮 Playing Hollow Knight · for 23 min"
export function Activity({ activity, style }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.activity}>
      <Icon name={ACTIVITY_ICONS[activity.kind] ?? 'monitor'} size={16} color={colors.text} />
      <Text style={[styles.activityText, style]}>{activityText(activity)} · {activityDuration(activity)}</Text>
    </View>
  );
}

// How loud they are for us in calls (#profile-volume-row: "Voice volume", 0-200 %). Not on our own
// profile, nor a bot's (bots never come into calls).
function VoiceVolume({ voice, userId }) {
  const styles = useStyles(makeStyles);
  const [percent, setPercent] = useState(voice.personVolume(userId));
  return (
    <View style={styles.volume}>
      <Text style={styles.volumeLabel}>Voice volume</Text>
      <View style={styles.volumeSlider}>
        <Slider
          value={percent} min={0} max={200} step={5}
          onChange={(value) => {
            setPercent(value);
            voice.setPersonVolume(userId, value);  // (heard at once, in a call)
          }}
        />
      </View>
      <Text style={styles.volumeValue}>{percent}%</Text>
    </View>
  );
}

// onOpen(key): open a chat (Message); onClose: close it. voice: useVoice()'s (the volume slider).
export default function ProfileScreen({ connection, voice, userId, onOpen, onClose }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { users, roles, me } = connection;
  const insets = useSafeAreaInsets();
  const [error, setError] = useState('');  // what the server said no with (a request, a block)
  const user = users[userId];
  if (!user) return null;  // (gone meanwhile)

  async function act(action, id) {
    setError('');
    const problem = await connection.friendAction(action, id);
    if (problem) setError(problem);
  }

  const theirRoles = roles.filter((role) => (user.roles ?? []).includes(role.id));
  // Message closes the profile on its way to the DM.
  const open = (key) => {
    onClose();
    onOpen(key);
  };
  const buttons = userId === me.id ? [] : friendButtons(user, connection, act, open);

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <View style={[styles.backdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.popup}>
          <ScrollView>
            <Banner user={user} />
            <View style={styles.content}>
              {/* The picture overlaps the banner, with a ring in the popup's colour. */}
              <View style={styles.picture}>
                <Avatar user={user} size={96} />
              </View>
              <View style={styles.nameLine}>
                <Text style={styles.name}>{user.name}</Text>
                {user.admin ? <View style={styles.admin}><Text style={styles.adminText}>Admin</Text></View> : null}
                {user.bot ? <BotBadge /> : null}
              </View>
              {theirRoles.length > 0 ? (
                <View style={styles.roles}>
                  {theirRoles.map((role) => (
                    <View key={role.id} style={styles.role}>
                      <View style={[styles.roleDot, { backgroundColor: role.colour }]} />
                      <Text style={styles.roleText}>{role.name}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {user.activity ? <Activity activity={user.activity} /> : null}
              {user.status ? <Text style={styles.status}>{user.status}</Text> : null}
              {user.bio ? <Text style={styles.bio}>{user.bio}</Text> : null}
              {buttons.length > 0 ? (
                <View style={styles.buttons}>
                  {buttons.map((button) => (
                    <Pressable
                      key={button.label}
                      onPress={button.onPress}
                      style={({ pressed }) => [styles.button, button.secondary && styles.secondary, pressed && styles.pressed]}
                    >
                      <Text style={styles.buttonText}>{button.label}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {userId !== me.id && !user.bot ? <VoiceVolume voice={voice} userId={userId} /> : null}
            </View>
          </ScrollView>
          <Pressable onPress={onClose} style={styles.close} hitSlop={8} accessibilityLabel="Close">
            <Icon name="x" size={18} color={colors.textStrong} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// chat.css's #profile, rem as 16 px.
const makeStyles = (colors, size) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  backdropTap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // min(500px, 100% - 32px) wide, the banner to the edges, rounded corners, everything centred.
  popup: {
    alignSelf: 'center', width: '100%', maxWidth: 500, maxHeight: '100%', borderRadius: 8, overflow: 'hidden',
    backgroundColor: colors.bgPanel,
  },
  banner: { width: '100%', aspectRatio: 3 },
  content: { alignItems: 'center', paddingHorizontal: 28, paddingBottom: 28 },
  picture: { marginTop: -54, marginBottom: 12, padding: 6, borderRadius: 54, backgroundColor: colors.bgPanel },
  nameLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  name: { fontSize: size(20.8), fontWeight: '700', color: colors.textStrong },
  // .admin-badge: 8px after the name, padding 2px 6px, radius 4px, the accent, 0.7rem.
  admin: { marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: colors.accent },
  adminText: { color: '#ffffff', fontSize: size(11.2) },
  // #profile-roles: centred tags, 6px apart; .role-tag: padding 2px 8px, radius 6px, 0.8rem.
  roles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginVertical: 6 },
  role: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
    backgroundColor: colors.bgDarkest,
  },
  roleDot: { width: 10, height: 10, borderRadius: 5 },
  roleText: { fontSize: size(12.8), color: colors.text },
  // #profile-activity: 8px above, 0.9rem.
  activity: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  activityText: { fontSize: size(14.4), color: colors.text },
  status: { marginTop: 4, fontSize: size(16), color: colors.textMuted, textAlign: 'center' },
  // #profile-bio: 16px above, left-aligned, the line breaks kept (Text keeps them by itself).
  bio: { alignSelf: 'stretch', marginTop: 16, fontSize: size(16), color: colors.text },
  // #profile .friend-actions: 20px above, the buttons sharing the width, padding 10px, 1rem.
  buttons: { flexDirection: 'row', gap: 6, marginTop: 20, alignSelf: 'stretch' },
  button: { flex: 1, alignItems: 'center', padding: 10, borderRadius: 6, backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: size(16) },
  error: { marginTop: 8, fontSize: size(13.6), color: colors.red },
  // #profile-volume-row: the label, the slider and the percentage on one line, 16px under the buttons.
  volume: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, alignSelf: 'stretch' },
  volumeLabel: { fontSize: size(14.4), color: colors.textSoft },
  volumeSlider: { flex: 1 },
  volumeValue: { width: 44, textAlign: 'right', fontSize: size(14.4), color: colors.textMuted },
  // #profile-close: a 32px circle at the top right, over the banner.
  close: {
    position: 'absolute', top: 12, right: 12, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgDarkest,
  },
});
