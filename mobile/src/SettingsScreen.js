// Settings (the web page's #settings popup, as it looks on a phone): the whole screen, a row of tabs
// along the top that scrolls sideways, × at its right end, and the chosen page under it.
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AccountSettings from './AccountSettings';
import AdminSettings from './AdminSettings';
import AppearanceSettings from './AppearanceSettings';
import ChangelogSettings from './ChangelogSettings';
import EmojiSettings from './EmojiSettings';
import FeedbackSettings from './FeedbackSettings';
import Icon from './Icon';
import NotificationSettings from './NotificationSettings';
import ProfileSettings from './ProfileSettings';
import { VideoSettings, VoiceSettings } from './VoiceSettings';
import { getJson } from './api';
import { useStyles, useTheme } from './theme';

const TABS = [
  { key: 'account', label: 'My Account' },
  { key: 'profile', label: 'Profile' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'emoji', label: 'Emoji' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'voice', label: 'Voice & audio' },
  { key: 'video', label: 'Video' },
  { key: 'changelog', label: "What's new" },
  { key: 'feedback', label: 'Bugs & ideas' },
];

// The tab from last time: Settings opens on it again (the web page does too, until a reload).
let lastPage = 'account';

// page: open on this tab (Edit profile: "profile"), or null for the one from last time.
// changelog: changelog.js's {changelog, unseen, markSeen} (App.js keeps it, for the dot on ⚙️ too).
// voice: useVoice()'s (Voice & audio, Video). notifications: useNotifications()'s (Notifications).
export default function SettingsScreen({ connection, voice, notifications, changelog, page, onClose }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const amAdmin = connection.users[connection.me.id]?.admin === true;
  const [tab, setTab] = useState(() => {
    const wanted = page ?? lastPage;
    return wanted === 'admin' && !amAdmin ? 'account' : wanted;  // (no longer an admin)
  });
  // Admins: the inbox's reports, fetched when Settings opens, for the tab's "Admin (2)" (open ones)
  // and its Inbox. null: on their way; false: couldn't load them.
  // Asked again when the Admin tab opens, so a report sent meanwhile shows up.
  const [reports, setReports] = useState(null);
  function loadReports() {
    if (amAdmin) getJson('/feedback').then((result) => setReports(result.ok ? result.data : false));
  }
  useEffect(loadReports, []);
  useEffect(() => {
    if (tab === 'admin') loadReports();
  }, [tab]);

  // The tab row opens with the chosen tab in sight (the web page's scrollIntoView "nearest"): once both
  // the row's width and that tab's place are known, scroll just far enough to show its right end.
  const tabRow = useRef(null);
  const rowWidth = useRef(0);
  const shown = useRef(false);
  function showChosen(x, width) {
    if (shown.current || !rowWidth.current || x === undefined) return;
    shown.current = true;
    if (x + width > rowWidth.current) tabRow.current?.scrollTo({ x: x + width - rowWidth.current + 8, animated: false });
  }
  const chosenPlace = useRef({});
  const openReports = reports ? reports.filter((report) => !report.done).length : 0;
  const tabs = amAdmin ? [...TABS, { key: 'admin', label: openReports ? `Admin (${openReports})` : 'Admin' }] : TABS;

  function pick(key) {
    lastPage = key;
    setTab(key);
  }

  return (
    <Modal animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      {/* Room for the status and navigation bars around it, and inside, KeyboardAvoidingView: the page
          moves up out of the keyboard's way, as in App.js. (Not both on one view: KeyboardAvoidingView
          sets its own bottom padding, the keyboard's height, which replaced the bar's.) */}
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <KeyboardAvoidingView behavior="padding" style={styles.screen}>
          {/* #settings-tabs on a phone: a row you swipe, ending before the ×. */}
          <View style={styles.top}>
            <ScrollView
              ref={tabRow} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}
              onLayout={(event) => {
                rowWidth.current = event.nativeEvent.layout.width;
                showChosen(chosenPlace.current.x, chosenPlace.current.width);
              }}
            >
              {tabs.map(({ key, label }) => (
                <Pressable
                  key={key}
                  onPress={() => pick(key)}
                  onLayout={key === tab ? (event) => {
                    chosenPlace.current = event.nativeEvent.layout;
                    showChosen(chosenPlace.current.x, chosenPlace.current.width);
                  } : undefined}
                  style={({ pressed }) => [styles.tab, tab === key && styles.tabChosen, pressed && tab !== key && styles.tabPressed]}
                >
                  <Text style={[styles.tabText, tab === key && styles.tabTextChosen]}>{label}</Text>
                  {/* The red dot after What's new: changes not seen yet. */}
                  {key === 'changelog' && changelog.unseen ? <View style={styles.newDot} /> : null}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable onPress={onClose} hitSlop={8} style={styles.close} accessibilityLabel="Close">
              <Icon name="x" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          {/* key: a new tab starts at its top, with fresh boxes. */}
          <ScrollView key={tab} style={styles.page} contentContainerStyle={styles.pageInside} keyboardShouldPersistTaps="handled">
            {tab === 'account' ? <AccountSettings /> : null}
            {tab === 'profile' ? <ProfileSettings connection={connection} /> : null}
            {tab === 'appearance' ? <AppearanceSettings /> : null}
            {tab === 'emoji' ? <EmojiSettings connection={connection} /> : null}
            {tab === 'notifications' ? <NotificationSettings notifications={notifications} /> : null}
            {tab === 'voice' ? <VoiceSettings voice={voice} /> : null}
            {tab === 'video' ? <VideoSettings voice={voice} /> : null}
            {tab === 'changelog' ? <ChangelogSettings connection={connection} changelog={changelog} /> : null}
            {tab === 'feedback' ? <FeedbackSettings /> : null}
            {tab === 'admin' && amAdmin ? <AdminSettings connection={connection} reports={reports} setReports={setReports} /> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// chat.css's #settings (and its phone rules), rem as 16 px.
const makeStyles = (colors, size) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgPanel },
  top: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgPanelAlt },
  // The row of tabs: padding 8px, 2px between them.
  tabs: { padding: 8, gap: 2 },
  // .settings-tab: padding 7px 10px, radius 4px, 0.95rem, soft; the chosen one highlighted.
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 4 },
  tabChosen: { backgroundColor: colors.bgActive },
  tabPressed: { backgroundColor: colors.bgHoverDim },
  tabText: { fontSize: size(15.2), color: colors.textSoft },
  tabTextChosen: { color: colors.textStrong },
  newDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },  // .new-dot
  close: { paddingHorizontal: 14, paddingVertical: 8 },
  page: { flex: 1 },
  // #settings-pages on a phone: padding 16px (and room at the bottom to scroll the last button up).
  pageInside: { padding: 16, paddingBottom: 48 },
});
