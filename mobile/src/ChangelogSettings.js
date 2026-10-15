// Settings → What's new (the web page's settings.js and its two <details> sections): Changes (open),
// one card per day, and "Everything ChatApp can do" (closed), one card per topic. Each line is
// formatted like a message (MessageText), so **bold**, `code` and the rest work in them.
// Opening this page marks every change as seen (changelog.js), which takes the red dots away.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import MessageText from './MessageText';
import { Title } from './SettingsParts';
import { useStyles, useTheme } from './theme';

// A heading that opens and closes what's under it (the web page's <summary>; the browser's ▶, turned ▼
// while open, is a chevron here).
function Section({ title, startOpen, children }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(startOpen);
  return (
    <View style={styles.section}>
      <Pressable onPress={() => setOpen(!open)} style={styles.summary}>
        <View style={open ? null : styles.closed}>
          <Icon name="chevron-down" size={16} color={colors.textSoft} />
        </View>
        <Text style={styles.summaryText}>{title}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

// One card: a title over a list of lines.
function Card({ title, items, connection }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {items.map((item, index) => (
        <View key={index} style={styles.line}>
          <Text style={styles.bullet}>•</Text>
          <View style={styles.lineText}>
            <MessageText text={item} users={connection.users} emoji={connection.emoji} />
          </View>
        </View>
      ))}
    </View>
  );
}

// "Thursday, 15 October 2026" in the phone's own language. "T12:00": midday, so it's the same day
// in every time zone (just "2026-10-15" means midnight in London, still the day before further west).
function dayText(date) {
  return new Date(date + 'T12:00').toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// changelog: changelog.js's {changelog, markSeen}.
export default function ChangelogSettings({ connection, changelog }) {
  const data = changelog.changelog;
  useEffect(() => changelog.markSeen(), [data]);  // seen once shown (and again if it changes meanwhile)
  return (
    <View>
      <Title>What's new</Title>
      {data ? (
        <>
          <Section title="Changes" startOpen>
            {data.changes.map((entry) => (
              <Card key={entry.date} title={dayText(entry.date)} items={entry.items} connection={connection} />
            ))}
          </Section>
          <Section title="Everything ChatApp can do" startOpen={false}>
            {data.features.map((group) => (
              <Card key={group.topic} title={group.topic} items={group.items} connection={connection} />
            ))}
          </Section>
        </>
      ) : null}
    </View>
  );
}

// chat.css's .changelog-section and .changelog-card.
const makeStyles = (colors, size) => StyleSheet.create({
  section: { marginBottom: 12 },
  // summary: padding 8px 0, 0.8rem, bold, uppercase, soft.
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  closed: { transform: [{ rotate: '-90deg' }] },
  summaryText: { fontSize: size(12.8), fontWeight: '600', textTransform: 'uppercase', color: colors.textSoft },
  // .changelog-card: 12px under it, padding 12px 14px, radius 8px, the panel colour (Settings' own).
  card: { marginBottom: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 8, backgroundColor: colors.bgPanel },
  cardTitle: { fontWeight: '600', color: colors.textStrong, fontSize: size(16) },
  // The list: 6px under the title, 20px in, 4px between lines.
  line: { flexDirection: 'row', marginTop: 4, paddingLeft: 4 },
  bullet: { width: 16, color: colors.text, fontSize: size(16) },
  lineText: { flex: 1 },
});
