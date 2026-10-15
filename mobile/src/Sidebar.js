// The left drawer: the web page's #sidebar. People (with a count of friend requests), the channels
// under their headings, Direct messages (groups first, then a DM with each friend), and your own
// panel at the bottom. Unread chats are white and bold with a dot on the left; mentions of you get
// a red count on the right.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { useStyles, useTheme } from './theme';
import { chatLabel, dmKey, groupName } from './chats';
import { Avatar, GroupPicture, Person, PersonPicture } from './people';
import { SeasonBadge } from './SeasonScreen';
import { LOUNGE, LOUNGE_ROOM } from './voice';

// Who's in a voice channel, under it (.voice-members): picture (a green ring while they talk), name,
// and the mic-off or headphone-off icon. A tap opens their profile.
function VoiceMembers({ members, users, speaking, onProfile }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.voiceMembers}>
      {members.map((member) => {
        const user = users[member.id];
        const icon = member.deafened ? 'headphone-off' : member.muted ? 'mic-off' : null;
        return (
          <Pressable
            key={member.id} onPress={() => onProfile(member.id)}
            style={({ pressed }) => [styles.voiceMember, pressed && styles.pressed]}
          >
            <View style={[styles.voiceRing, speaking.has(member.id) && styles.voiceRingOn]}>
              <Avatar user={user} size={24} />
            </View>
            <Text numberOfLines={1} style={styles.voiceName}>{user?.name ?? '?'}</Text>
            {icon ? <Icon name={icon} size={16} color={colors.icon} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// The voice bar (#voice-bar) above your panel while you're in voice or joining: how it's going ("Voice
// connected" in green), where (a tap goes there), then camera, share and leave sharing a line.
function VoiceBar({ voice, where, onOpen }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const statusColor = { ok: colors.green, waiting: colors.yellow, error: colors.red }[voice.status?.kind] ?? colors.green;
  const button = (icon, label, onPress, on) => (
    <Pressable
      onPress={onPress} accessibilityLabel={label}
      style={({ pressed }) => [styles.voiceButton, on && styles.voiceButtonOn, pressed && styles.panelPressed]}
    >
      <Icon name={icon} size={20} color={on ? '#ffffff' : colors.icon} />
    </Pressable>
  );
  return (
    <View style={styles.voiceBar}>
      <Pressable onPress={onOpen} style={styles.voiceInfo}>
        <Text numberOfLines={1} style={[styles.voiceStatus, { color: statusColor }]}>{voice.status?.text ?? ''}</Text>
        <Text numberOfLines={1} style={styles.voiceWhere}>{where}</Text>
      </Pressable>
      <View style={styles.voiceButtons}>
        {button('video', voice.camera ? 'Turn off camera' : 'Turn on camera', voice.toggleCamera, voice.camera)}
        {button('monitor-up', voice.sharing ? 'Stop sharing' : 'Share your screen', voice.toggleShare, voice.sharing)}
        {button('phone-off', 'Leave voice', voice.leave)}
      </View>
    </View>
  );
}

// One row of the list, like the web page's .channel buttons. `children` is a function that draws
// what's in it, told whether the text should be white (`strong`) and bold (unread). onLongPress: a
// DM's user menu.
// (Defined out here, not inside Sidebar: a component defined inside another is a new one at every
// redraw, so React would rebuild every row each time, pictures included.)
// A muted chat is faded and has no unread dot (a red count still shows: a mention by name).
function Row({ chatKey, active, unread, mentions, mutedChats, onPress, onLongPress, children }) {
  const styles = useStyles(makeStyles);
  const muted = chatKey && mutedChats.has(chatKey);
  const isUnread = chatKey && unread.has(chatKey) && !active && !muted;
  const count = (chatKey && mentions[chatKey]) || 0;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row, active && styles.active, pressed && !active && styles.pressed, muted && !active && styles.muted,
      ]}
    >
      {isUnread ? <View style={styles.unreadDot} /> : null}
      <View style={styles.rowInside}>{children(active || isUnread, isUnread)}</View>
      {count > 0 ? <View style={styles.mentionBadge}><Text style={styles.badgeText}>{count}</Text></View> : null}
    </Pressable>
  );
}

// onUserMenu(id): a DM's long press. onNewGroup: the + by "Direct messages". onMe: your panel at the
// bottom. onSettings: its ⚙️ (settingsDot: a red dot on it, What's new has news; notificationsMuted:
// a bell-off on it). onSeason: the
// seasonal easter egg on your picture. voice: useVoice()'s (the Voice list, the voice bar, mute and
// deafen); onProfile(id): someone in voice was tapped.
export default function Sidebar({
  connection, voice, view, onPick, onPeople, onUserMenu, onNewGroup, onMe, onSettings, settingsDot, notificationsMuted,
  onSeason, onProfile,
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { channels, groups, friends, users, roles, me, myPresence, unread, mentions, mutedChats, incoming } = connection;
  const inLounge = voice.roomName === LOUNGE_ROOM;
  // The voice bar's "where": Lounge, or the DM's or group's name. A tap there opens it.
  const where = voice.roomName === null ? '' : inLounge ? 'Lounge' : chatLabel(voice.roomName, connection);
  const openCall = () => onPick(inLounge ? LOUNGE : voice.roomName);
  // A panel button (mute, deafen): red with a white icon while on (.user-panel-button.off).
  const panelButton = (icon, label, onPress, off) => (
    <Pressable
      onPress={onPress} hitSlop={4} accessibilityLabel={label}
      style={({ pressed }) => [styles.panelButton, off && styles.panelButtonOff, pressed && !off && styles.panelPressed]}
    >
      {({ pressed }) => <Icon name={icon} size={22} color={off ? '#ffffff' : pressed ? colors.iconStrong : colors.icon} />}
    </Pressable>
  );
  const marks = { unread, mentions, mutedChats };  // every Row gets these: <Row {...marks} ...>

  // The text colour of a row: white when it's the open chat or unread, else muted.
  const textStyle = (strong, bold) => [styles.rowText, strong && styles.rowTextStrong, bold && styles.bold];

  const dms = friends.map((id) => users[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const mine = users[me.id];

  return (
    <View style={styles.sidebar}>
      <ScrollView style={styles.lists} contentContainerStyle={styles.listsInside}>
        <Row {...marks} active={view === 'people'} onPress={onPeople}>
          {(strong) => (
            <>
              <Icon name="users" color={strong ? colors.iconStrong : colors.icon} />
              <Text style={[textStyle(strong), styles.grow]}>People</Text>
              {incoming.length > 0 ? (
                <View style={styles.badge}><Text style={styles.badgeText}>{incoming.length}</Text></View>
              ) : null}
            </>
          )}
        </Row>

        {channels.map((channel) => (channel.heading ? (
          <Text key={channel.key} style={styles.heading}>{channel.name}</Text>
        ) : (
          <Row {...marks} key={channel.key} chatKey={channel.key} active={view === channel.key} onPress={() => onPick(channel.key)}>
            {(strong, bold) => <Text numberOfLines={1} style={[textStyle(strong, bold), styles.grow]}># {channel.name}</Text>}
          </Row>
        )))}

        {/* Voice: the Lounge (green while we're in it; a tap opens its page and joins), and who's in it. */}
        <Text style={styles.heading}>Voice</Text>
        <Row {...marks} active={view === LOUNGE} onPress={() => onPick(LOUNGE)}>
          {(strong) => (
            <>
              <Icon name="volume-2" color={inLounge ? colors.green : strong ? colors.iconStrong : colors.icon} />
              <Text numberOfLines={1} style={[textStyle(strong), styles.grow, inLounge && styles.inVoice]}>Lounge</Text>
            </>
          )}
        </Row>
        <VoiceMembers
          members={connection.voiceMembers[LOUNGE_ROOM] ?? []} users={users} speaking={voice.speaking} onProfile={onProfile}
        />

        {/* "Direct messages" and its + for a new group (the web page's #new-group). */}
        <View style={styles.headingRow}>
          <Text style={[styles.heading, styles.grow]}>Direct messages</Text>
          <Pressable onPress={onNewGroup} hitSlop={10} accessibilityLabel="New group" style={styles.newGroup}>
            {({ pressed }) => <Icon name="plus" size={18} color={pressed ? colors.iconStrong : colors.icon} />}
          </Pressable>
        </View>
        {groups.map((group) => (
          <Row {...marks} key={group.key} chatKey={group.key} active={view === group.key} onPress={() => onPick(group.key)}>
            {(strong, bold) => (
              <View style={styles.person}>
                <GroupPicture />
                <Text numberOfLines={1} style={[textStyle(strong, bold), styles.grow]}>{groupName(group, users, me.id)}</Text>
              </View>
            )}
          </Row>
        ))}
        {dms.map((user) => {
          const key = dmKey(me.id, user.id);
          return (
            <Row {...marks} key={key} chatKey={key} active={view === key} onPress={() => onPick(key)} onLongPress={() => onUserMenu(user.id)}>
              {(strong, bold) => (
                <Person
                  user={user} roles={roles} me={me} myPresence={myPresence} bold={bold}
                  color={strong ? colors.textStrong : colors.textMuted}
                  ring={view === key ? colors.bgActive : colors.bgPanel}
                />
              )}
            </Row>
          );
        })}
      </ScrollView>

      {voice.roomName !== null ? <VoiceBar voice={voice} where={where} onOpen={openCall} /> : null}

      {/* You, at the bottom (the web page's #user-panel): your picture with your status and your name
          (a tap opens your popup, MeScreen), then mute, deafen and ⚙️ Settings. (On the web page the
          buttons are a second row; a phone's drawer has room for them beside the name.) */}
      {mine ? (
        <View style={styles.userPanel}>
          <Pressable onPress={onMe} style={({ pressed }) => [styles.me, pressed && styles.panelPressed]}>
            {/* 4px of room around the picture (from the panel's own padding), for the seasonal badge. */}
            <View style={styles.myPicture}>
              <PersonPicture user={mine} me={me} myPresence={myPresence} size={40} ring={colors.bgPanelAlt} />
              {me.season ? <SeasonBadge season={me.season} onPress={onSeason} /> : null}
            </View>
            <Text numberOfLines={1} style={styles.myName}>{mine.name}</Text>
          </Pressable>
          {panelButton(voice.muted ? 'mic-off' : 'mic', voice.muted ? 'Unmute' : 'Mute', voice.toggleMute, voice.muted)}
          {panelButton(
            voice.deafened ? 'headphone-off' : 'headphones', voice.deafened ? 'Undeafen' : 'Deafen', voice.toggleDeafen, voice.deafened,
          )}
          <Pressable
            onPress={onSettings} hitSlop={6} accessibilityLabel="Settings"
            style={({ pressed }) => [styles.panelButton, pressed && styles.panelPressed]}
          >
            {({ pressed }) => (
              <>
                <Icon name="settings" size={22} color={pressed ? colors.iconStrong : colors.icon} />
                {settingsDot ? <View style={styles.settingsDot} /> : null}
                {notificationsMuted ? (
                  <View style={styles.mutedIcon}><Icon name="bell-off" size={11} color={colors.icon} /></View>
                ) : null}
              </>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  sidebar: { flex: 1, backgroundColor: colors.bgPanel },
  lists: { flex: 1 },
  listsInside: { paddingHorizontal: 8, paddingTop: 16, paddingBottom: 8, gap: 2 },
  // .section-heading: 0.75rem, uppercase, muted, margin 16px 0 8px, padding 0 12px.
  heading: {
    color: colors.textMuted, fontSize: size(12), fontWeight: '600', textTransform: 'uppercase',
    marginTop: 16, marginBottom: 8, paddingHorizontal: 12,
  },
  // .channel on a phone: padding 12px, radius 6px.
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 6 },
  rowInside: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  active: { backgroundColor: colors.bgActive },
  pressed: { backgroundColor: colors.bgHover },
  muted: { opacity: 0.5 },  // .channel.muted
  rowText: { color: colors.textMuted, fontSize: size(16) },
  rowTextStrong: { color: colors.textStrong },
  bold: { fontWeight: '600' },
  grow: { flex: 1 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  // The unread dot: 8px, white, on the row's left edge.
  unreadDot: { position: 'absolute', left: 1, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textStrong },
  // .mention-badge: a red pill with the count, at the row's right end.
  mentionBadge: {
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 5, marginLeft: 6,
    backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center',
  },
  // .badge (friend requests): 18px tall.
  badge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center',
  },
  badgeText: { color: '#ffffff', fontSize: size(11), fontWeight: '700' },
  panelPressed: { backgroundColor: colors.bgHover },
  // The heading with the + at its right end (the + sits where the heading's text would end).
  headingRow: { flexDirection: 'row', alignItems: 'center' },
  newGroup: { marginTop: 16, marginBottom: 8, paddingHorizontal: 12 },
  userPanel: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 8, backgroundColor: colors.bgPanelAlt },
  me: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 4, borderRadius: 6, minWidth: 0 },
  panelButton: { padding: 10, borderRadius: 6 },
  myPicture: { padding: 4, margin: -4 },
  // #settings-new-dot: the red dot in ⚙️'s top corner.
  settingsDot: { position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  // #muted-icon: notifications are muted (or Do Not Disturb), a small bell-off on ⚙️'s bottom corner.
  mutedIcon: { position: 'absolute', bottom: 4, right: 4 },
  myName: { flex: 1, color: colors.textStrong, fontSize: size(13.6), fontWeight: '600' },
  panelButtonOff: { backgroundColor: colors.buttonRed },
  // .voice-channel.in-voice: green and bold.
  inVoice: { color: colors.green, fontWeight: '600' },
  // .voice-members: indented 24px; each row 3px 8px, a 24px picture, 0.9rem muted text.
  voiceMembers: { paddingLeft: 24, gap: 2 },
  voiceMember: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 },
  // The speaking ring: 2px around the picture, transparent until they talk (so nothing moves).
  voiceRing: { padding: 2, margin: -2, borderRadius: 14, borderWidth: 2, borderColor: 'transparent' },
  voiceRingOn: { borderColor: colors.green },
  voiceName: { flex: 1, color: colors.textMuted, fontSize: size(14.4) },
  // #voice-bar: a line above it, the status and where on the first line, the buttons sharing the second.
  voiceBar: { paddingHorizontal: 8, paddingVertical: 8, gap: 4, borderTopWidth: 1, borderTopColor: colors.border },
  voiceInfo: { paddingHorizontal: 4 },
  voiceStatus: { fontSize: size(13.6), fontWeight: '600' },
  voiceWhere: { fontSize: size(12.8), color: colors.textMuted },
  voiceButtons: { flexDirection: 'row', gap: 4 },
  voiceButton: { flex: 1, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  voiceButtonOn: { backgroundColor: colors.buttonGreen },
});
