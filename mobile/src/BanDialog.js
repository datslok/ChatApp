// Banning someone (the web page's people.js, "Banning", and its #ban-dialog): an optional reason (shown
// to them when they try to log in), how long, and Ban. Opened by Ban… in the user menu and by Settings →
// Admin → Bans. The server (server.py, "Bans and admins") decides who may ban whom; mayBan only decides
// whether to offer it.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DialogButton, DialogButtons, Popup, makeStyles as makePopupStyles } from './MessageCard';
import { postJson } from './api';
import { useStyles, useTheme } from './theme';
import { limits } from './limits';

// The web page's drop-down, as buttons side by side (four short choices suit a phone better).
const LENGTHS = [[null, 'For good'], [1, '1 day'], [7, '1 week'], [30, '1 month']];

// May we ban this person? Never ourselves, bots or the owner; an admin only if we're the owner.
export function mayBan(user, users, me) {
  const mine = users[me.id];
  return !!mine?.admin && user.id !== me.id && !user.bot && !user.owner && (!user.admin || !!mine.owner);
}

// user: whom to ban. onBanned(answer): done (the server's new list of bans); onClose: closes it.
export default function BanDialog({ user, onBanned, onClose }) {
  const popupStyles = useStyles(makePopupStyles);
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(null);  // "For good" first
  const [problem, setProblem] = useState(null);

  async function ban() {
    const result = await postJson('/admin/ban', { user_id: user.id, reason, days });
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    onBanned?.(result.data);
    onClose();
  }

  return (
    <Popup title={`Ban ${user.name}?`} onClose={onClose}>
      <Text style={popupStyles.help}>
        They're logged out straight away and can't log in until the ban ends. They aren't told who banned them,
        only the reason.
      </Text>
      <Text style={styles.label}>Reason (optional, shown to them)</Text>
      <TextInput
        style={popupStyles.input} value={reason} onChangeText={setReason} maxLength={limits.ban_reason}
        placeholderTextColor={colors.textMuted}
      />
      <Text style={styles.label}>How long</Text>
      <View style={styles.lengths}>
        {LENGTHS.map(([value, label]) => (
          <Pressable key={label} onPress={() => setDays(value)} style={[styles.length, days === value && styles.chosen]}>
            <Text style={[styles.lengthText, days === value && styles.chosenText]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {problem ? <Text style={[popupStyles.problem, styles.problem]}>{problem}</Text> : null}
      <DialogButtons>
        <DialogButton label="Cancel" secondary onPress={onClose} />
        <DialogButton label="Ban" danger onPress={ban} />
      </DialogButtons>
    </Popup>
  );
}

// chat.css's .ban-field: the words 6px over the box, 0.85rem, muted.
const makeStyles = (colors, size) => StyleSheet.create({
  label: { marginTop: 12, marginBottom: 6, fontSize: size(13.6), color: colors.textMuted },
  // Like Search's This chat / Everywhere: one dark strip, the chosen part lighter.
  lengths: { flexDirection: 'row', padding: 2, borderRadius: 6, backgroundColor: colors.bgDarkest },
  length: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 5 },
  chosen: { backgroundColor: colors.bgActive },
  lengthText: { fontSize: size(13.6), color: colors.textMuted },
  chosenText: { color: colors.textStrong },
  problem: { marginTop: 10 },
});
