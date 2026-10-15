// Settings (the web page's #settings popup, as it looks on a phone): the whole screen, a row of tabs
// along the top that scrolls sideways, × at its right end, and the chosen page under it.
// (The web page has more tabs: Emoji, What's new, Bugs & ideas and Admin come in their own step,
// Notifications with push notifications, Voice & audio and Video with calls; see ROADMAP.md.)
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AccountSettings from './AccountSettings';
import AppearanceSettings from './AppearanceSettings';
import Icon from './Icon';
import ProfileSettings from './ProfileSettings';
import { useStyles, useTheme } from './theme';

const TABS = [
  { key: 'account', label: 'My Account' },
  { key: 'profile', label: 'Profile' },
  { key: 'appearance', label: 'Appearance' },
];

// The tab from last time: Settings opens on it again (the web page does too, until a reload).
let lastPage = 'account';

// page: open on this tab (Edit profile: "profile"), or null for the one from last time.
export default function SettingsScreen({ connection, page, onClose }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState(page ?? lastPage);

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
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
              {TABS.map(({ key, label }) => (
                <Pressable
                  key={key}
                  onPress={() => pick(key)}
                  style={({ pressed }) => [styles.tab, tab === key && styles.tabChosen, pressed && tab !== key && styles.tabPressed]}
                >
                  <Text style={[styles.tabText, tab === key && styles.tabTextChosen]}>{label}</Text>
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
  tab: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 4 },
  tabChosen: { backgroundColor: colors.bgActive },
  tabPressed: { backgroundColor: colors.bgHoverDim },
  tabText: { fontSize: size(15.2), color: colors.textSoft },
  tabTextChosen: { color: colors.textStrong },
  close: { paddingHorizontal: 14, paddingVertical: 8 },
  page: { flex: 1 },
  // #settings-pages on a phone: padding 16px (and room at the bottom to scroll the last button up).
  pageInside: { padding: 16, paddingBottom: 48 },
});
