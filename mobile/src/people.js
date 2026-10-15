// People, drawn like the web page's people.js: pictures (or a letter in a coloured circle), the
// status dot on a picture's corner, the BOT tag, names in their top role's colour, and the "person"
// row (picture, name, what they're doing) used in the sidebar's DMs and the member list.
import { Image, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { letterColors, useStyles, useTheme } from './theme';
import { SERVER } from './config';

// Someone's top role (roles come top first, so the first of theirs found is the top one), or null.
export function topRole(user, roles) {
  const ids = user?.roles ?? [];
  return roles.find((role) => ids.includes(role.id)) ?? null;
}

// The colour for someone's name: their top role's, or undefined (the place's own text colour).
export function nameColor(user, roles) {
  return topRole(user, roles)?.colour;
}

// The person picker's suggestions (the web page's matchPeople): names starting with what's typed
// first, then names containing it; at most 8.
export function matchPeople(typed, people) {
  const query = typed.trim().toLowerCase();
  const name = (person) => person.name.toLowerCase();
  return [
    ...people.filter((person) => name(person).startsWith(query)),
    ...people.filter((person) => !name(person).startsWith(query) && name(person).includes(query)),
  ].slice(0, 8);
}

// "Playing Hollow Knight", "Listening to Song by Artist", "Using Visual Studio Code".
export function activityText(activity) {
  if (activity.kind === 'playing') return 'Playing ' + activity.name;
  if (activity.kind === 'listening') {
    return 'Listening to ' + activity.name + (activity.details ? ' by ' + activity.details : '');
  }
  return 'Using ' + activity.name;
}

// A profile picture: 40 (messages, your panel), 24 (lists) or 16 (reply quotes). The picture comes
// from the server's /avatars/, which only answers logged-in people: the app's image loader sends
// the login cookie along by itself, like fetch and the WebSocket. Without a picture: the first
// letter of the name in a circle, in the person's own colour (picked by their id).
export function Avatar({ user, name, size = 40 }) {
  const styles = useStyles(makeStyles);
  const { colors, size: textSize } = useTheme();
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (user?.avatar) {
    return <Image source={{ uri: `${SERVER}/avatars/${encodeURIComponent(user.avatar)}` }} style={round} />;
  }
  const letter = (name || user?.name || '?').charAt(0).toUpperCase();
  const background = user?.id ? letterColors[user.id % letterColors.length] : colors.bgNeutral;
  // The web page's letter sizes: 2.5rem at 96 px (a profile), 2rem at 80 (your popup), 1rem at 40,
  // 0.75rem at 24, 0.55rem at 16.
  const fontSize = size >= 80 ? size * 0.41 : size >= 40 ? 16 : size >= 24 ? 12 : 9;
  return (
    <View style={[round, styles.letter, { backgroundColor: background }]}>
      <Text style={[styles.letterText, { fontSize: textSize(fontSize) }]}>{letter}</Text>
    </View>
  );
}

// The status dot on a picture's bottom right corner, with a ring in the colour behind it so it
// stands apart from the picture. Only on phones: a little phone shape instead of a dot. Our own
// Invisible shows to us as a ring (the others just see us offline). ring: the colour behind it (the
// sidebar's, if none is given).
export function StatusDot({ presence, mobile, ring, size = 10 }) {
  const styles = useStyles(makeStyles);
  const theme = useTheme();
  ring = ring ?? theme.colors.bgPanel;
  const color = theme.presence[presence] ?? theme.presence.offline;
  const border = { borderWidth: 2, borderColor: ring };
  if (mobile && presence !== 'offline' && presence !== 'invisible') {
    const width = size * 0.8;
    const height = size * 1.2;
    return (
      <View style={[styles.corner, border, { width: width + 4, height: height + 4, borderRadius: 3, backgroundColor: color }]}>
        <View style={[styles.screen, { backgroundColor: ring }]} />
      </View>
    );
  }
  const shape = { width: size + 4, height: size + 4, borderRadius: (size + 4) / 2 };
  if (presence === 'invisible') {
    return (
      <View style={[styles.corner, shape, border, { backgroundColor: ring }]}>
        <View style={{ flex: 1, borderRadius: size / 2, borderWidth: 2.5, borderColor: color }} />
      </View>
    );
  }
  return <View style={[styles.corner, shape, border, { backgroundColor: color }]} />;
}

// The little "BOT" tag after a bot's name. A box of its own (React Native can't pad text in the
// middle of a line), so it goes next to the name's <Text>, not inside it.
export function BotBadge() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.bot}>
      <Text style={styles.botText}>BOT</Text>
    </View>
  );
}

// A picture with its status dot.
export function PersonPicture({ user, me, myPresence, size = 24, ring }) {
  // What the others see; but we see our own Invisible as such (they see us offline).
  const presence = user.id === me?.id && myPresence === 'invisible' ? 'invisible' : user.presence;
  return (
    <View>
      <Avatar user={user} size={size} />
      <StatusDot presence={presence} mobile={user.mobile} ring={ring} size={size >= 40 ? 14 : 10} />
    </View>
  );
}

// One person: picture with dot, name (role colour, BOT tag), and what they're doing or their status.
// color: the name's colour when they have no role colour (muted, if none is given).
export function Person({ user, roles, me, myPresence, color, ring, bold }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  color = color ?? colors.textMuted;
  const line = user.activity ? activityText(user.activity) : user.status;
  return (
    <View style={styles.person}>
      <PersonPicture user={user} me={me} myPresence={myPresence} ring={ring} />
      <View style={styles.personText}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={[styles.personName, { color: nameColor(user, roles) ?? color }, bold && styles.bold]}>
            {user.name}
          </Text>
          {user.bot ? <BotBadge /> : null}
        </View>
        {line ? <Text numberOfLines={1} style={styles.personStatus}>{line}</Text> : null}
      </View>
    </View>
  );
}

// A group DM's picture: a grey circle with the "users" icon (the web page's .group-avatar).
export function GroupPicture({ size = 24 }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={[styles.letter, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.bgNeutral }]}>
      <Icon name="users" size={size * 0.6} color={colors.textStrong} />
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  letter: { alignItems: 'center', justifyContent: 'center' },
  letterText: { color: '#ffffff', fontWeight: '600' },
  corner: { position: 'absolute', right: -4, bottom: -4 },
  screen: { position: 'absolute', top: 1.5, left: 1.5, right: 1.5, bottom: 3, borderRadius: 1 },
  // .bot-badge: padding 1px 5px, radius 4px, 0.65rem, weight 600, 6px after the name.
  bot: { marginLeft: 6, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.botBadge, alignSelf: 'center' },
  botText: { color: colors.botBadgeText, fontSize: size(10.4), fontWeight: '600', letterSpacing: 0.3 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  personText: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center' },
  personName: { flexShrink: 1, fontSize: size(16) },
  bold: { fontWeight: '600' },
  personStatus: { fontSize: size(12), color: colors.textMuted },
});
