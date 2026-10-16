// Settings → Admin (the web page's settings.js, "Admin"; only for admins): a row of sub-tabs, each one
// section: Inbox (bug reports and ideas), Channels, Roles, Invites, Bans, and Admins (the owner's alone).
// The server checks every admin request itself: hiding the tab only keeps it out of everyone else's way.
//
// Channels and roles are the connection's own lists: each change goes to the server, which tells every
// page and app ("channels", "roles", "users"), and that redraws these lists too. The inbox, invites and
// bans are asked for when their section opens (the web page asks when Settings opens).
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ColourDialog } from './AppearanceSettings';
import BanDialog, { mayBan } from './BanDialog';
import Icon from './Icon';
import { Checkbox } from './GroupScreen';
import { InviteRow } from './InviteScreen';
import PersonPicker from './PersonPicker';
import { Button, Form, Heading, Help, Status, Title } from './SettingsParts';
import { getJson, postJson } from './api';
import { Avatar, Person } from './people';
import { useStyles, useTheme } from './theme';
import { clock, dayName } from './time';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "14 Oct 2026" (the web page's dateStyle "medium").
function shortDay(iso) {
  const date = new Date(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Android's OK / Cancel box (the web page's confirm()). onYes runs if they press `yes`.
function confirm(title, text, yes, onYes) {
  Alert.alert(title, text, [{ text: 'Cancel', style: 'cancel' }, { text: yes, style: 'destructive', onPress: onYes }]);
}

// The section from last time: Admin opens on it again (the web page does too, until a reload).
let lastSection = 'inbox';

// reports: the inbox's reports (SettingsScreen fetched them, for the tab's count), setReports to change them.
export default function AdminSettings({ connection, reports, setReports }) {
  const styles = useStyles(makeStyles);
  const { users, me } = connection;
  const amOwner = users[me.id]?.owner === true;
  const [section, setSection] = useState(lastSection === 'admins' && !amOwner ? 'inbox' : lastSection);

  const sections = [
    ['inbox', 'Inbox'], ['channels', 'Channels'], ['roles', 'Roles'], ['invites', 'Invites'], ['bans', 'Bans'],
    ...(amOwner ? [['admins', 'Admins']] : []),
  ];
  function pick(key) {
    lastSection = key;
    setSection(key);
  }

  return (
    <View>
      <Title>Admin</Title>
      <View style={styles.tabs}>
        {sections.map(([key, label]) => (
          <Pressable key={key} onPress={() => pick(key)} style={[styles.tab, section === key && styles.tabChosen]}>
            <Text style={[styles.tabText, section === key && styles.tabTextChosen]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {section === 'inbox' ? <Inbox connection={connection} reports={reports} setReports={setReports} /> : null}
      {section === 'channels' ? <Channels connection={connection} /> : null}
      {section === 'roles' ? <Roles connection={connection} /> : null}
      {section === 'invites' ? <Invites connection={connection} /> : null}
      {section === 'bans' ? <Bans connection={connection} /> : null}
      {section === 'admins' ? <Admins connection={connection} /> : null}
    </View>
  );
}

// The help at a section's top, with room under it.
function SectionHelp({ children }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.sectionHelp}><Help>{children}</Help></View>;
}

// A small grey button with an icon (the web page's makeChannelAdminButton): ↑, ↓, 🗑, ×.
function IconButton({ icon, label, onPress, disabled }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress} disabled={disabled} accessibilityLabel={label} hitSlop={4}
      style={({ pressed }) => [styles.small, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Icon name={icon} size={16} color={colors.text} />
    </Pressable>
  );
}

// A small button with words: grey, or the accent colour (`main`: Save).
function SmallButton({ label, onPress, main, disabled }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.small, main && styles.smallMain, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

// Send a change and show what went wrong, if anything. Returns whether it worked.
async function adminRequest(path, data, setStatus) {
  const result = await postJson(path, data);
  setStatus(result.ok ? null : { text: result.error, error: true });
  return result.ok;
}

// A checkbox and its words, all of it tappable (the web page's makeCheckbox), with a role's dot if given.
function CheckLine({ checked, label, onPress, dot }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.checkLine, pressed && styles.pressed]}>
      <Checkbox checked={checked} />
      {dot ? <View style={[styles.roleDot, { backgroundColor: dot }]} /> : null}
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

// ---------- Inbox ----------

// "Chrome on Android", "Windows app", "Android app", ... from the User-Agent the report came with
// (the web page's describeDevice: rough guesses by looking for known words; the order matters).
function describeDevice(userAgent) {
  if (!userAgent) return 'unknown device';
  if (userAgent.startsWith('ChatApp Windows app')) return 'Windows app';
  if (userAgent.startsWith('ChatApp Android app')) return 'Android app';
  let browser = 'a browser';
  if (userAgent.includes('Edg/')) browser = 'Edge';
  else if (userAgent.includes('OPR/')) browser = 'Opera';
  else if (userAgent.includes('Firefox/') || userAgent.includes('FxiOS/')) browser = 'Firefox';
  else if (userAgent.includes('Chrome/') || userAgent.includes('CriOS/')) browser = 'Chrome';
  else if (userAgent.includes('Safari/')) browser = 'Safari';
  let system = '';
  if (userAgent.includes('Android')) system = 'Android';
  else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) system = 'iPhone/iPad';
  else if (userAgent.includes('Windows')) system = 'Windows';
  else if (userAgent.includes('Mac OS X')) system = 'Mac';
  else if (userAgent.includes('Linux')) system = 'Linux';
  return system ? `${browser} on ${system}` : browser;
}

let lastFilter = 'open';

function Inbox({ connection, reports, setReports }) {
  const styles = useStyles(makeStyles);
  const [filter, setFilter] = useState(lastFilter);  // "open", "done" or "all"
  if (reports === null) return <Help>Loading…</Help>;
  if (reports === false) return <Help>Couldn't load the reports.</Help>;
  const shown = reports.filter((report) => filter === 'all' || (filter === 'done' ? report.done : !report.done));
  return (
    <View>
      <View style={styles.filters}>
        {[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => {
              lastFilter = key;
              setFilter(key);
            }}
            style={[styles.filter, filter === key && styles.filterChosen]}
          >
            <Text style={[styles.filterText, filter === key && styles.filterTextChosen]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {shown.length === 0 ? <Help>{filter === 'open' ? 'Nothing open. 🎉' : 'Nothing here yet.'}</Help> : null}
      <View style={styles.cards}>
        {shown.map((report) => (
          <Report
            key={report.id} report={report} connection={connection}
            onDone={(done) => setReports(reports.map((other) => (other.id === report.id ? { ...other, done } : other)))}
          />
        ))}
      </View>
    </View>
  );
}

// One report as a card: who and when, the text, where it was sent from, and Mark done / Reopen.
function Report({ report, connection, onDone }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const user = connection.users[report.user_id];
  const sent = new Date(report.created_at);
  const bug = report.kind === 'bug';
  // .inbox-kind: its colour mixed with the panel's for the background, and with white for the words.
  const kindColour = bug ? colors.red : colors.green;

  async function toggle() {
    setBusy(true);
    const result = await postJson(`/feedback/${report.id}/done`, { done: !report.done });
    setBusy(false);
    if (result.ok) onDone(!report.done);
    else setProblem(result.error);
  }

  return (
    <View style={[styles.card, report.done && styles.done]}>
      <View style={styles.cardHead}>
        <Avatar user={user} name="someone" size={24} />
        <Text style={styles.cardName}>{user?.name ?? 'someone'}</Text>
        <View style={[styles.kind, { backgroundColor: kindColour + '33' }]}>
          <Icon name={bug ? 'bug' : 'lightbulb'} size={13} color={kindColour} />
          <Text style={[styles.kindText, { color: kindColour }]}>{bug ? 'Bug' : 'Idea'}</Text>
        </View>
        <Text style={styles.cardTime}>{dayName(sent)} at {clock(sent)}</Text>
      </View>
      {/* Text someone typed, shown as text (never as code), with its line breaks. */}
      <Text style={styles.cardText} selectable>{report.text}</Text>
      <View style={styles.cardFoot}>
        <Text style={styles.cardDevice}>{problem ?? `#${report.id} · from ${describeDevice(report.user_agent)}`}</Text>
        <SmallButton label={report.done ? 'Reopen' : 'Mark done'} main={!report.done} onPress={toggle} disabled={busy} />
      </View>
    </View>
  );
}

// ---------- Channels ----------

// One channel or heading: "#" (or an arrow), its name in a box (Save shows once it's changed; the
// keyboard's Enter saves too), ↑ ↓ and 🗑. A channel also gets who can see it under its row.
function ChannelRow({ item, index, count, roles, onRename, onMove, onDelete, onAccess }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [name, setName] = useState(item.name);
  useEffect(() => setName(item.name), [item.name]);  // renamed (here or elsewhere): the box follows
  const changed = name.trim() !== item.name;
  const row = (
    <View style={[styles.adminRow, item.heading && styles.headingRow]}>
      <View style={styles.mark}>
        {item.heading ? <Icon name="chevron-down" size={16} color={colors.textMuted} /> : <Text style={styles.markText}>#</Text>}
      </View>
      <TextInput
        style={[styles.rowInput, item.heading && styles.headingInput]} value={name} onChangeText={setName} maxLength={30}
        onSubmitEditing={() => changed && onRename(name)} returnKeyType="done" autoCorrect={false}
        accessibilityLabel={item.heading ? 'Heading name' : 'Channel name'}
      />
      {changed ? <SmallButton label="Save" main onPress={() => onRename(name)} /> : null}
      <IconButton icon="arrow-up" label="Move up" disabled={index === 0} onPress={() => onMove(index, -1)} />
      <IconButton icon="arrow-down" label="Move down" disabled={index === count - 1} onPress={() => onMove(index, 1)} />
      <IconButton icon="trash-2" label="Delete" onPress={onDelete} />
    </View>
  );
  if (item.heading) return row;
  return (
    <View>
      {row}
      <ChannelAccess item={item} roles={roles} onAccess={onAccess} />
    </View>
  );
}

// Who can see a channel (the web page's makeChannelAccess): "Private" ticked = only the ticked roles
// (and the owner, who sees everything), else everyone (but people with a limited role). Sent at once.
function ChannelAccess({ item, roles, onAccess }) {
  const styles = useStyles(makeStyles);
  const toggle = (id) => onAccess(true, item.roles.includes(id) ? item.roles.filter((other) => other !== id) : [...item.roles, id]);
  const help = roles.length === 0 ? 'Only the owner sees it. Make a role under Roles to let others in.'
    : item.roles.length === 0 ? 'No role ticked: only the owner sees it.' : null;
  return (
    <View style={styles.access}>
      <CheckLine checked={item.private} label="Private" onPress={() => onAccess(!item.private, item.roles)} />
      {item.private ? roles.map((role) => (
        <CheckLine key={role.id} checked={item.roles.includes(role.id)} label={role.name} dot={role.colour} onPress={() => toggle(role.id)} />
      )) : null}
      {item.private && help ? <Help>{help}</Help> : null}
    </View>
  );
}

function Channels({ connection }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { channels, roles } = connection;
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState(null);

  // Swap a row with the one above (-1) or below (+1), and send the whole new order.
  function move(index, step) {
    const keys = channels.map((item) => item.key);
    [keys[index], keys[index + step]] = [keys[index + step], keys[index]];
    adminRequest('/channels/order', { keys }, setStatus);
  }

  function remove(item) {
    if (item.heading) {
      confirm('Delete this heading?', `"${item.name}": the channels under it stay.`, 'Delete',
        () => adminRequest(`/channels/${encodeURIComponent(item.key)}/delete`, {}, setStatus));
    } else {
      confirm(`Delete #${item.name}?`, "Every message and file in it goes too. This can't be undone.", 'Delete',
        () => adminRequest(`/channels/${encodeURIComponent(item.key)}/delete`, {}, setStatus));
    }
  }

  async function add(heading) {
    if (await adminRequest('/channels', { name: newName, heading }, setStatus)) {
      setNewName('');
      setStatus({ text: heading ? 'Heading added at the bottom.' : 'Channel added at the bottom.' });
    }
  }

  return (
    <View>
      <SectionHelp>
        The sidebar, top to bottom. A heading groups the channels under it. Everyone sees changes straight away. A private
        channel is only for the roles ticked under it and the owner (other admins don't see it either).
      </SectionHelp>
      <View style={styles.channelList}>
        {channels.map((item, index) => (
          <ChannelRow
            key={item.key} item={item} index={index} count={channels.length} roles={roles} onMove={move}
            onDelete={() => remove(item)}
            onRename={(name) => adminRequest(`/channels/${encodeURIComponent(item.key)}/rename`, { name }, setStatus)}
            onAccess={(isPrivate, ids) => adminRequest(`/channels/${encodeURIComponent(item.key)}/access`,
              { private: isPrivate, roles: ids }, setStatus)}
          />
        ))}
      </View>
      <Heading>Add</Heading>
      <Form>
        <TextInput
          style={styles.input} value={newName} onChangeText={setNewName} maxLength={30} placeholder="e.g. games"
          placeholderTextColor={colors.textMuted} autoCorrect={false} accessibilityLabel="Name"
        />
        <View style={styles.buttonRow}>
          <Button label="Add channel" onPress={() => add(false)} disabled={!newName.trim()} />
          <Button label="Add heading" onPress={() => add(true)} disabled={!newName.trim()} />
        </View>
        <Status status={status} />
      </Form>
    </View>
  );
}

// ---------- Roles ----------

// One role: its colour (tap to pick), its name (Save once changed), ↑ ↓ 🗑, and under it its people,
// each with × to take it away, and "+ Add someone" to give it to someone else. Then Limited.
function RoleRow({ role, index, count, connection, onEdit, onMove, onDelete, onMember, onPickColour, onLimited, onHidden }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [name, setName] = useState(role.name);
  useEffect(() => setName(role.name), [role.name]);
  const changed = name.trim() !== role.name;
  const everyone = Object.values(connection.users);
  const members = everyone.filter((user) => (user.roles ?? []).includes(role.id));
  return (
    <View style={styles.role}>
      <View style={styles.adminRow}>
        <Pressable onPress={onPickColour} accessibilityLabel="Colour" style={[styles.colourBox, { backgroundColor: role.colour }]} />
        <TextInput
          style={styles.rowInput} value={name} onChangeText={setName} maxLength={30} autoCorrect={false}
          onSubmitEditing={() => changed && onEdit({ name, colour: role.colour })} accessibilityLabel="Role name"
        />
        {changed ? <SmallButton label="Save" main onPress={() => onEdit({ name, colour: role.colour })} /> : null}
        <IconButton icon="arrow-up" label="Move up" disabled={index === 0} onPress={() => onMove(index, -1)} />
        <IconButton icon="arrow-down" label="Move down" disabled={index === count - 1} onPress={() => onMove(index, 1)} />
        <IconButton icon="trash-2" label="Delete" onPress={onDelete} />
      </View>
      <View style={styles.members}>
        {members.map((user) => (
          <View key={user.id} style={styles.member}>
            <Avatar user={user} size={16} />
            <Text style={styles.memberName}>{user.name}</Text>
            <Pressable onPress={() => onMember(user, false)} hitSlop={8} accessibilityLabel={`Take ${role.name} from ${user.name}`}>
              <Icon name="x" size={14} color={colors.textMuted} />
            </Pressable>
          </View>
        ))}
      </View>
      <PersonPicker
        placeholder="+ Add someone" style={styles.roleAdd}
        candidates={everyone.filter((user) => !(user.roles ?? []).includes(role.id))}
        onPick={(user) => onMember(user, true)}
      />
      <CheckLine
        checked={role.limited} onPress={() => onLimited(!role.limited)}
        label="Limited: sees only the private channels it's ticked in, no other channels and no Lounge"
      />
      <CheckLine
        checked={role.hidden} onPress={() => onHidden(!role.hidden)}
        label="Hidden: only admins see this role, and it doesn't colour names or get a section"
      />
    </View>
  );
}

function Roles({ connection }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { roles } = connection;
  const [status, setStatus] = useState(null);
  const [newName, setNewName] = useState('');
  const [newColour, setNewColour] = useState('#3ba55c');
  const [picking, setPicking] = useState(null);  // whose colour is being picked: a role, or "new"

  const edit = (role, change) => adminRequest(`/roles/${role.id}/edit`, change, setStatus);

  function move(index, step) {
    const ids = roles.map((role) => role.id);
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    adminRequest('/roles/order', { ids }, setStatus);
  }

  async function add() {
    if (await adminRequest('/roles', { name: newName, colour: newColour }, setStatus)) {
      setNewName('');
      setStatus({ text: 'Role added at the bottom. Give it to people with "+ Add someone".' });
    }
  }

  return (
    <View>
      <SectionHelp>
        A role colours its people's names and gives them a section in the member list. Someone with several roles gets
        the one highest in this list. Everyone sees changes straight away. A limited role's people only see their DMs,
        groups and the private channels it's ticked in (Channels). A hidden role is only known to admins.
      </SectionHelp>
      <View style={styles.roleList}>
        {roles.map((role, index) => (
          <RoleRow
            key={role.id} role={role} index={index} count={roles.length} connection={connection}
            onEdit={(change) => edit(role, change)} onMove={move} onPickColour={() => setPicking(role)}
            onDelete={() => confirm('Delete this role?', `"${role.name}": everyone who has it loses it.`, 'Delete',
              () => adminRequest(`/roles/${role.id}/delete`, {}, setStatus))}
            onMember={(user, member) => adminRequest(`/roles/${role.id}/members`, { user_id: user.id, member }, setStatus)}
            onLimited={(limited) => adminRequest(`/roles/${role.id}/limited`, { limited }, setStatus)}
            onHidden={(hidden) => adminRequest(`/roles/${role.id}/hidden`, { hidden }, setStatus)}
          />
        ))}
      </View>
      <Heading>Add a role</Heading>
      <View style={styles.adminRow}>
        <Pressable onPress={() => setPicking('new')} accessibilityLabel="Colour" style={[styles.colourBox, { backgroundColor: newColour }]} />
        <TextInput
          style={styles.rowInput} value={newName} onChangeText={setNewName} maxLength={30} placeholder="e.g. Gamers"
          placeholderTextColor={colors.textMuted} autoCorrect={false} accessibilityLabel="Name"
        />
        <SmallButton label="Add role" main onPress={add} disabled={!newName.trim()} />
      </View>
      <Status status={status} />
      {picking ? (
        <ColourDialog
          label="Colour" value={picking === 'new' ? newColour : picking.colour} onPreview={() => {}}
          onCancel={() => setPicking(null)}
          onDone={(hex) => {
            if (picking === 'new') setNewColour(hex);
            else edit(picking, { name: picking.name, colour: hex });
            setPicking(null);
          }}
        />
      ) : null}
    </View>
  );
}

// ---------- Invites ----------

// A person's row (Invites' "joined", Bans, Admins): their picture and name while they're in the lists,
// else just the name the server gave; a line about them; and a button at the end, if any.
function PersonRow({ connection, userId, name, details, button, onPress }) {
  const styles = useStyles(makeStyles);
  const user = connection.users[userId];
  return (
    <View style={styles.personRow}>
      <View style={styles.personTop}>
        {user ? (
          <Person user={user} roles={connection.roles} me={connection.me} color={undefined} />
        ) : (
          <Text style={styles.plainName}>{name}</Text>
        )}
        {button ? <SmallButton label={button} onPress={onPress} /> : null}
      </View>
      <Text style={styles.details}>{details}</Text>
    </View>
  );
}

function Invites({ connection }) {
  const [data, setData] = useState(null);  // {open: [{code, link, by, expires}], joined: [{user_id, name, invited_by, joined}]}
  const [status, setStatus] = useState(null);
  useEffect(() => {
    getJson('/admin/invites').then((result) => {
      if (result.ok) setData(result.data);
      else setStatus({ text: "Couldn't load the invites.", error: true });
    });
  }, []);

  async function cancel(code) {
    const result = await postJson(`/admin/invites/${encodeURIComponent(code)}/cancel`);
    if (result.ok) setData(result.data);
    else setStatus({ text: result.error, error: true });
  }

  return (
    <View>
      <SectionHelp>Invite links that still work, whoever made them, and who joined with whose link.</SectionHelp>
      <Heading>Open links</Heading>
      {data?.open.length === 0 ? <Help>No open links.</Help> : null}
      {data?.open.map((invite) => <InviteRow key={invite.code} invite={invite} onCancel={() => cancel(invite.code)} />)}
      <Heading>Joined</Heading>
      {data?.joined.length === 0 ? <Help>Nobody has joined with a link yet.</Help> : null}
      {data?.joined.map((entry) => (
        <PersonRow
          key={entry.user_id ?? entry.name + entry.joined} connection={connection} userId={entry.user_id}
          name={entry.name ?? 'a deleted account'}
          details={`invited by ${entry.invited_by ?? 'a deleted account'} · ${shortDay(entry.joined)}`}
        />
      ))}
      <Status status={status} />
    </View>
  );
}

// ---------- Bans ----------

function Bans({ connection }) {
  const { users, me } = connection;
  const [bans, setBans] = useState(null);  // [{user_id, name, by, at, until (null: for good), reason}]
  const [status, setStatus] = useState(null);
  const [banning, setBanning] = useState(null);  // the person the ban popup is for
  useEffect(() => {
    getJson('/admin/bans').then((result) => {
      if (result.ok) setBans(result.data.bans);
      else setStatus({ text: "Couldn't load the bans.", error: true });
    });
  }, []);

  function unban(ban) {
    confirm(`Unban ${ban.name}?`, 'They can log in again straight away.', 'Unban', async () => {
      const result = await postJson('/admin/unban', { user_id: ban.user_id });
      if (result.ok) setBans(result.data.bans);
      else setStatus({ text: result.error, error: true });
    });
  }

  return (
    <View>
      <SectionHelp>
        A banned person is logged out, can't log in until the ban ends, and disappears from everyone's lists. Their
        messages stay. Admins can't be banned, except by the owner.
      </SectionHelp>
      <PersonPicker
        placeholder="Ban someone: type a name" candidates={Object.values(users).filter((user) => mayBan(user, users, me))}
        onPick={setBanning}
      />
      <Heading>Banned now</Heading>
      {bans?.length === 0 ? <Help>Nobody is banned.</Help> : null}
      {bans?.map((ban) => (
        <PersonRow
          key={ban.user_id} connection={connection} userId={ban.user_id} name={ban.name} button="Unban" onPress={() => unban(ban)}
          details={[
            `by ${ban.by ?? 'someone'} on ${shortDay(ban.at)}`,
            ban.until ? `until ${shortDay(ban.until)}` : 'for good',
            ban.reason ? `"${ban.reason}"` : '',
          ].filter(Boolean).join(' · ')}
        />
      ))}
      <Status status={status} />
      {banning ? <BanDialog user={banning} onBanned={(data) => setBans(data.bans)} onClose={() => setBanning(null)} /> : null}
    </View>
  );
}

// ---------- Admins (the owner only) ----------

// Make someone an admin, or take it away (the user menu's Make admin / Remove admin too). Asks first.
export function askToSetAdmin(user, admin, onProblem) {
  confirm(
    admin ? `Make ${user.name} an admin?` : `Remove ${user.name} as an admin?`,
    admin ? "They can edit and delete anyone's messages, manage channels and roles, read the inbox and ban people." : '',
    admin ? 'Make admin' : 'Remove admin',
    async () => {
      const result = await postJson('/admin/admins', { user_id: user.id, admin });
      if (!result.ok) onProblem(result.error);
    },
  );
}

function Admins({ connection }) {
  const styles = useStyles(makeStyles);
  const { users } = connection;
  const [status, setStatus] = useState(null);
  const everyone = Object.values(users);
  // Drawn from the users list, which says who's an admin; the server sends a fresh one after each change.
  const admins = everyone.filter((user) => user.admin && !user.bot);
  const problem = (text) => setStatus({ text, error: true });
  return (
    <View>
      <SectionHelp>Admins can edit and delete anyone's messages, manage channels and roles, read the inbox, and ban people.</SectionHelp>
      <View style={styles.adminList}>
        {admins.map((user) => (user.owner
          ? <PersonRow key={user.id} connection={connection} userId={user.id} details="owner" />
          : (
            <PersonRow
              key={user.id} connection={connection} userId={user.id} details="admin" button="Remove admin"
              onPress={() => askToSetAdmin(user, false, problem)}
            />
          )))}
      </View>
      <PersonPicker
        placeholder="Make someone an admin: type a name" candidates={everyone.filter((user) => !user.admin && !user.bot)}
        onPick={(user) => askToSetAdmin(user, true, problem)}
      />
      <Status status={status} />
    </View>
  );
}

// chat.css's Admin rules, rem as 16 px.
const makeStyles = (colors, size) => StyleSheet.create({
  // .admin-section > .settings-help: 12px under the help at a section's top.
  sectionHelp: { marginBottom: 12 },
  // .admin-tabs: wrapping, 4px apart, a line under them; each padding 6px 12px, 0.95rem, muted.
  tabs: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 },
  tabChosen: { backgroundColor: colors.bgActive },
  tabText: { fontSize: size(15.2), color: colors.textMuted },
  tabTextChosen: { color: colors.textStrong },
  // .channel-admin-item button: padding 6px 10px, 0.85rem, grey (Save: the accent colour).
  small: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: colors.bgNeutral, alignItems: 'center', justifyContent: 'center' },
  smallMain: { backgroundColor: colors.accent },
  smallText: { color: '#ffffff', fontSize: size(13.6) },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  // #inbox-filters: pills, 6px apart, 12px above the cards.
  filters: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  filter: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.bgHoverDim },
  filterChosen: { backgroundColor: colors.accent },
  filterText: { fontSize: size(14.4), color: colors.textSoft },
  filterTextChosen: { color: '#ffffff' },
  cards: { gap: 10 },
  // .inbox-item: padding 12px 14px, radius 8px, the panel colour (Settings' own).
  card: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 8, backgroundColor: colors.bgPanel },
  done: { opacity: 0.6 },
  cardHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  cardName: { fontWeight: '700', color: colors.text, fontSize: size(16) },
  kind: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 1, paddingHorizontal: 8, borderRadius: 10 },
  kindText: { fontSize: size(12), fontWeight: '600' },
  cardTime: { fontSize: size(12.8), color: colors.textMuted },
  cardText: { marginVertical: 8, color: colors.text, fontSize: size(16) },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  cardDevice: { flex: 1, fontSize: size(12.8), color: colors.textMuted },
  // Channels: rows 6px apart; a heading's row 10px further down, its name small and uppercase.
  channelList: { gap: 6, marginTop: 12, marginBottom: 8 },
  adminRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headingRow: { marginTop: 10 },
  mark: { width: 20, alignItems: 'center' },
  markText: { color: colors.textMuted, fontSize: size(16) },
  rowInput: {
    flex: 1, minWidth: 0, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  headingInput: { fontSize: size(12.8), fontWeight: '600', textTransform: 'uppercase' },
  input: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.bgDarkest,
    color: colors.text, fontSize: size(16),
  },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Roles: each role, its people as chips (.role-member: padding 2px 4px 2px 6px, radius 6px, 0.85rem).
  roleList: { gap: 16, marginTop: 12 },
  role: { gap: 8 },
  // .channel-access: under a channel's row, lined up with its name; label.checkbox at 0.85rem.
  access: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4, marginLeft: 26, marginVertical: 4 },
  checkLine: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  checkText: { flexShrink: 1, fontSize: size(13.6), color: colors.text },
  roleDot: { width: 10, height: 10, borderRadius: 5 },
  colourBox: { width: 36, height: 30, borderRadius: 4, borderWidth: 1, borderColor: colors.line },
  members: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  member: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2, paddingLeft: 6, paddingRight: 6,
    borderRadius: 6, backgroundColor: colors.bgDarkest,
  },
  memberName: { fontSize: size(13.6), color: colors.text },
  roleAdd: { maxWidth: 260 },
  // .admin-person-row / .joined-row: a line under each, the details 0.85rem and muted.
  personRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line, gap: 4 },
  personTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  plainName: { flex: 1, fontWeight: '700', color: colors.text, fontSize: size(16) },
  details: { fontSize: size(13.6), color: colors.textMuted },
  adminList: { marginBottom: 12 },
});
