// The right drawer: the web page's member list (#members, people.js renderMembers). Who's in the
// chat we're in: everyone in a channel, the two people in a DM, a group's members. Bots in their own
// section at the top, then each role with its online people (by their top role), the other online
// people, and everyone offline at the bottom, dimmed. A tap opens someone's profile, a long press the
// user menu.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useStyles, useTheme } from './theme';
import { dmPartner, seesChannel } from './chats';
import { Person, topRole } from './people';

export default function Members({ connection, view, onProfile, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { users, roles, groups, channels, me, myPresence } = connection;
  const everyone = Object.values(users).sort((a, b) => a.name.localeCompare(b.name));

  const partner = dmPartner(view, me.id);
  const group = groups.find((g) => g.key === view);
  const channel = channels.find((item) => item.key === view && !item.heading);
  let members = everyone;
  if (partner !== null) members = everyone.filter((user) => user.id === me.id || user.id === partner);
  else if (group) members = everyone.filter((user) => group.members.includes(user.id));
  else if (channel) members = everyone.filter((user) => seesChannel(user, channel, roles));

  const bots = members.filter((user) => user.bot);
  const humans = members.filter((user) => !user.bot);
  const online = humans.filter((user) => user.online && !topRole(user, roles));
  const offline = humans.filter((user) => !user.online);

  const sections = [];
  if (bots.length > 0) sections.push({ title: `Bots — ${bots.length}`, people: bots });
  for (const role of roles) {
    const people = humans.filter((user) => user.online && topRole(user, roles) === role);
    if (people.length > 0) sections.push({ title: `${role.name} — ${people.length}`, people });
  }
  // In a DM an empty Online or Offline says nothing, so it's left out; groups and channels keep both.
  if (partner === null || online.length > 0) sections.push({ title: `Online — ${online.length}`, people: online });
  if (partner === null || offline.length > 0) sections.push({ title: `Offline — ${offline.length}`, people: offline, dim: true });

  return (
    <ScrollView style={styles.members} contentContainerStyle={styles.inside}>
      {sections.map((section, index) => (
        <View key={section.title} style={index > 0 && styles.later}>
          <Text style={styles.heading}>{section.title}</Text>
          {section.people.map((user) => (
            <Pressable
              key={user.id}
              onPress={() => onProfile(user.id)}
              onLongPress={() => onUserMenu(user.id)}
              style={({ pressed }) => [styles.person, section.dim && styles.dim, pressed && styles.pressed]}
            >
              <Person user={user} roles={roles} me={me} myPresence={myPresence} color={colors.textMuted} />
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  members: { flex: 1, backgroundColor: colors.bgPanel },
  inside: { padding: 16 },
  later: { marginTop: 20 },  // every section but the first: 20px above it
  heading: { color: colors.textMuted, fontSize: size(12), fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
  person: { paddingVertical: 4, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: 6 },
  pressed: { backgroundColor: colors.bgHover },
  dim: { opacity: 0.5 },
});
