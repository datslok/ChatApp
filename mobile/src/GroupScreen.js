// Group DMs (the web page's people.js, "Group DMs"): private chats for 3 to 10 people. Here are the
// popup that starts a group or adds people to one, renaming, and the group's menu (from the ⋯ in the
// top bar). None of them change the lists themselves: the server answers every member's devices with
// a fresh "groups", which redraws the sidebar, the top bar and the members; leaving takes App.js
// back to the first channel when that "groups" no longer has the group.
import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Icon from './Icon';
import { DialogButton, DialogButtons, Popup, styles as popupStyles, useFocusSoon } from './MessageCard';
import { Sheet, SheetItem, SheetLine } from './Sheet';
import { postJson } from './api';
import { groupName, groupPeople } from './chats';
import { colors } from './colors';
import { Person } from './people';

const MAX_GROUP_SIZE = 10;  // as the server's
const MAX_NAME = 30;        // (the web page's maxlength; the server's MAX_CHANNEL_NAME)

// A checkbox: a rounded square, filled with a tick when ticked.
function Checkbox({ checked }) {
  return (
    <View style={[styles.box, checked && styles.boxChecked]}>
      {checked ? <Icon name="check" size={14} color="#ffffff" /> : null}
    </View>
  );
}

// groupKey: null starts a new group, a key adds people to that one. onCreated(key): the new group
// is made (App.js opens it).
export function GroupDialog({ connection, groupKey, onCreated, onClose }) {
  const { users, roles, me, myPresence, friends, groups } = connection;
  const group = groups.find((g) => g.key === groupKey);
  const members = group ? groupPeople(group, users) : [me.id];
  const [chosen, setChosen] = useState([]);  // the ticked friends' ids
  const [filter, setFilter] = useState('');  // the search box over them
  const [name, setName] = useState('');
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState(false);  // (no double groups from a double tap)

  // Friends not in it yet; never bots (they're in every group by themselves). Alphabetically.
  const choices = friends.map((id) => users[id])
    .filter((user) => user && !user.bot && !members.includes(user.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  // The search box: only names containing what's typed; ticked ones always stay in sight.
  const typed = filter.trim().toLowerCase();
  const shown = choices.filter((user) => !typed || chosen.includes(user.id) || user.name.toLowerCase().includes(typed));
  const full = members.length + chosen.length >= MAX_GROUP_SIZE;  // nobody more can be ticked
  const enough = chosen.length >= (group ? 1 : 2);

  function toggle(id) {
    setChosen((old) => (old.includes(id) ? old.filter((other) => other !== id) : [...old, id]));
  }

  async function submit() {
    setSending(true);
    setProblem('');
    const result = group
      ? await postJson(`/groups/${encodeURIComponent(group.key)}/add`, { user_ids: chosen })
      : await postJson('/groups', { user_ids: chosen, name });
    setSending(false);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    onClose();
    if (!group) onCreated(result.data.key);  // a new group: go there
  }

  const help = group
    ? `Pick friends to add (up to ${MAX_GROUP_SIZE - members.length} more). They'll see the whole chat.`
    : `Pick 2 to ${MAX_GROUP_SIZE - 1} friends. Everyone in a group can read and write in it, add their own friends, and leave. Chattus is in every group: write @Chattus to ask him something.`;

  return (
    <Popup title={group ? 'Add people' : 'New group'} onClose={onClose}>
      <View style={styles.gap}>
        <Text style={popupStyles.help}>{help}</Text>
        <TextInput
          style={popupStyles.input}
          value={filter}
          onChangeText={setFilter}
          placeholder="Search your friends"
          placeholderTextColor={colors.textMuted}
          autoCorrect={false}
        />
      </View>
      {/* The friends to tick: a list that scrolls on its own when there are many. */}
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {choices.length === 0 ? (
          <Text style={styles.empty}>
            {group ? 'All your friends are in it already.' : 'Add friends first: groups are made with friends.'}
          </Text>
        ) : null}
        {shown.map((user) => {
          const checked = chosen.includes(user.id);
          const disabled = !checked && full;
          return (
            <Pressable
              key={user.id}
              onPress={() => toggle(user.id)}
              disabled={disabled}
              style={({ pressed }) => [styles.choice, disabled && styles.faded, pressed && styles.pressed]}
            >
              <Checkbox checked={checked} />
              <Person user={user} roles={roles} me={me} myPresence={myPresence} color={colors.text} ring={colors.bgPanel} />
            </Pressable>
          );
        })}
      </ScrollView>
      {group ? null : (
        <View style={styles.nameRow}>
          <Text style={styles.label}>Name (optional)</Text>
          <TextInput
            style={[popupStyles.input, styles.nameInput]}
            value={name}
            onChangeText={setName}
            maxLength={MAX_NAME}
            placeholder="e.g. Weekend plans"
            placeholderTextColor={colors.textMuted}
          />
        </View>
      )}
      {problem ? <Text style={[popupStyles.problem, styles.problem]}>{problem}</Text> : null}
      <DialogButtons>
        <DialogButton label="Cancel" secondary onPress={onClose} />
        <DialogButton label={group ? 'Add' : 'Create group'} onPress={submit} disabled={!enough || sending} />
      </DialogButtons>
    </Popup>
  );
}

// Renaming (the web page asks with the browser's prompt(); Android has no such box, so a small popup).
export function RenameDialog({ connection, groupKey, onClose }) {
  const group = connection.groups.find((g) => g.key === groupKey);
  const [name, setName] = useState(group?.name ?? '');
  const [problem, setProblem] = useState('');
  const box = useRef(null);
  useFocusSoon(box);

  async function save() {
    const result = await postJson(`/groups/${encodeURIComponent(groupKey)}/rename`, { name });
    if (result.ok) onClose();
    else setProblem(result.error);
  }

  return (
    <Popup title="Rename group" onClose={onClose}>
      <View style={styles.gap}>
        <Text style={popupStyles.help}>Leave it empty to name it after its members.</Text>
        <TextInput
          ref={box}
          style={[popupStyles.input, styles.nameInput]}
          value={name}
          onChangeText={setName}
          onSubmitEditing={save}
          maxLength={MAX_NAME}
          selectTextOnFocus
          placeholder="e.g. Weekend plans"
          placeholderTextColor={colors.textMuted}
        />
        {problem ? <Text style={popupStyles.problem}>{problem}</Text> : null}
      </View>
      <DialogButtons>
        <DialogButton label="Cancel" secondary onPress={onClose} />
        <DialogButton label="Save" onPress={save} />
      </DialogButtons>
    </Popup>
  );
}

// The ⋯ in a group's top bar: Add people, Rename, Leave (the web page's three buttons in the bar,
// which a phone's top bar has no room for). onAdd, onRename: open those popups.
export function GroupMenu({ connection, groupKey, onAdd, onRename, onClose }) {
  const { groups, users, me } = connection;
  const group = groups.find((g) => g.key === groupKey);
  if (!group) return null;

  function leave() {
    onClose();
    const last = groupPeople(group, users).length === 1;
    Alert.alert(
      last ? 'Leave this group?' : `Leave ${groupName(group, users, me.id)}?`,
      last ? "You're the last one in it, so it's deleted with all its messages."
        : 'You can only come back if someone adds you again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            const result = await postJson(`/groups/${encodeURIComponent(groupKey)}/leave`);
            if (!result.ok) Alert.alert('', result.error);
          },
        },
      ],
    );
  }

  const choose = (action) => () => {
    onClose();
    action();
  };
  return (
    <Sheet title={groupName(group, users, me.id)} onClose={onClose}>
      <SheetItem icon="user-plus" label="Add people" onPress={choose(onAdd)} />
      <SheetItem icon="pencil" label="Rename" onPress={choose(onRename)} />
      <SheetLine />
      <SheetItem icon="log-out" label="Leave group" danger onPress={leave} />
    </Sheet>
  );
}

// chat.css's #group-dialog.
const styles = StyleSheet.create({
  gap: { gap: 10 },  // #group-form: 10px between its parts
  list: { flexGrow: 0, flexShrink: 1, marginTop: 10 },
  empty: { fontSize: 14.4, color: colors.textMuted, paddingVertical: 6 },
  // .group-choice: the box and the person, padding 6px 8px.
  choice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6 },
  pressed: { backgroundColor: colors.bgHover },
  faded: { opacity: 0.5 },  // can't be ticked: the group would be too big
  box: {
    width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: colors.textMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  boxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  // #group-name-row: the label (0.85rem, soft) over its box (padding 10px 12px, 1rem).
  nameRow: { gap: 6, marginTop: 10 },
  label: { fontSize: 13.6, color: colors.textSoft },
  nameInput: { paddingVertical: 10, paddingHorizontal: 12, fontSize: 16 },
  problem: { marginTop: 10 },
});
