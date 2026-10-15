// Invite someone (the web page's people.js, "Invites"): new accounts need an invite link from someone
// in the chat. The popup shows our unused links, each with Copy, × to cancel it, and until when it
// works; New link makes another and copies it straight away. Each link works once, for a week.
// The server answers every change with the whole list again ({invites: [{code, link, expires}], days}).
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DialogButton, DialogButtons, Popup, styles as popupStyles } from './MessageCard';
import { getJson, postJson } from './api';
import { colors } from './colors';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "22 Oct 2026, 14:30" in our own time zone (the server sends UTC: "2026-10-22T12:30:00Z").
function untilText(iso) {
  const date = new Date(iso);
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export default function InviteScreen({ onClose }) {
  const [answer, setAnswer] = useState(null);  // the server's list (null: on its way)
  const [status, setStatus] = useState(null);  // {text, success} under the list, or null
  const [newCode, setNewCode] = useState(null);  // the link New link just made (framed)
  const [copied, setCopied] = useState(null);    // the link whose Copy just said "Copied ✓"

  // The list, when the popup opens.
  useEffect(() => {
    getJson('/invites').then((result) => {
      if (result.ok) setAnswer(result.data);
      else setStatus({ text: "Couldn't load your links. Try again in a moment." });
    });
  }, []);

  // New link and × both answer with the whole list. Returns that answer (null if it failed).
  async function inviteAction(path) {
    setStatus(null);
    const result = await postJson(path);
    if (!result.ok) {
      setStatus({ text: result.error });
      return null;
    }
    setAnswer(result.data);
    return result.data;
  }

  async function copy(link) {
    await Clipboard.setStringAsync(link);
    setCopied(link);
    setTimeout(() => setCopied((now) => (now === link ? null : now)), 2000);
  }

  // New link: the new one is the code that wasn't in the list before. It goes straight onto the
  // clipboard (that's what you'd do next anyway), gets a frame, and a green line says so.
  async function makeInvite() {
    const before = new Set((answer?.invites ?? []).map((invite) => invite.code));
    const next = await inviteAction('/invites');
    const invite = next?.invites.find((item) => !before.has(item.code));
    if (!invite) return;
    setNewCode(invite.code);
    await Clipboard.setStringAsync(invite.link);
    setStatus({ text: "New link made and copied ✓ Paste it to the person you're inviting.", success: true });
  }

  return (
    <Popup title="Invite someone" onClose={onClose}>
      {answer ? (
        <Text style={[popupStyles.help, styles.help]}>
          Each link lets one person make an account, within {answer.days} days. Send it to them yourself.
        </Text>
      ) : null}
      <ScrollView style={styles.list}>
        {answer?.invites.length === 0 ? <Text style={styles.empty}>No unused links. Tap New link to make one.</Text> : null}
        {answer?.invites.map((invite) => (
          <View key={invite.code} style={styles.row}>
            <View style={styles.line}>
              {/* One line, "…" in the middle. Not selectable (the web page's box is): on Android, selectable
                  text ignores numberOfLines and showed half a second line. Copy is the way to copy it. */}
              <View style={[styles.linkBox, invite.code === newCode && styles.newLink]}>
                <Text numberOfLines={1} ellipsizeMode="middle" style={styles.link}>{invite.link}</Text>
              </View>
              <Pressable onPress={() => copy(invite.link)} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                <Text style={styles.buttonText}>{copied === invite.link ? 'Copied ✓' : 'Copy'}</Text>
              </Pressable>
              <Pressable
                onPress={() => inviteAction(`/invites/${encodeURIComponent(invite.code)}/cancel`)}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                accessibilityLabel="Cancel this link"
              >
                <Text style={styles.buttonText}>×</Text>
              </Pressable>
            </View>
            <Text style={styles.expires}>Works once, until {untilText(invite.expires)}</Text>
          </View>
        ))}
      </ScrollView>
      {status ? <Text style={[status.success ? popupStyles.success : popupStyles.problem, styles.status]}>{status.text}</Text> : null}
      <DialogButtons>
        <DialogButton label="Close" secondary onPress={onClose} />
        <DialogButton label="New link" onPress={makeInvite} />
      </DialogButtons>
    </Popup>
  );
}

// chat.css's #invite-dialog and .invite-row.
const styles = StyleSheet.create({
  help: { marginBottom: 10 },
  list: { flexGrow: 0, flexShrink: 1 },
  empty: { fontSize: 14.4, color: colors.textMuted },
  row: { marginBottom: 6 },
  // The address (monospace, 0.85rem), Copy and ×, 6px apart.
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkBox: {
    flex: 1, minWidth: 0, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, borderWidth: 2,
    borderColor: 'transparent', backgroundColor: colors.bgDarkest,
  },
  link: { color: colors.text, fontFamily: 'monospace', fontSize: 13.6 },
  newLink: { borderColor: colors.accent },  // .invite-row.new: framed in the accent colour
  button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.bgNeutral },
  pressed: { opacity: 0.8 },
  buttonText: { color: colors.text, fontSize: 14.4 },
  expires: { marginTop: 4, fontSize: 12, color: colors.textMuted },
  status: { marginTop: 10 },
});
