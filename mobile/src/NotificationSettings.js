// Settings → Notifications (the web page's), kept on the phone (notifications.js). Where a phone differs:
// "Desktop notifications" and "on this device when the chat is closed" are one switch here, push, which
// covers the app being in the background or closed; and Android's own settings can block them, or keep a
// ringing call's screen off the lock screen, so we say so, with a button to the right place.
import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Checkbox } from './GroupScreen';
import { Button, Heading, Help, Title } from './SettingsParts';
import Slider from './Slider';
import { Choices } from './VoiceSettings';
import { MUTE_CHOICES, isMuted } from './notifications';
import { clock, isSameDay } from './time';
import { useStyles } from './theme';
import {
  canFillScreen, notificationsAllowed, openFillScreenSettings, openNotificationSettings,
} from '../modules/push';

// A checkbox and its words, all of it tappable (the web page's <label class="checkbox">).
function CheckRow({ checked, label, onPress, disabled }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.checkRow, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Checkbox checked={checked} />
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

// "Muted until 14:30." (the web page's showMuteState)
function muteText(settings) {
  if (!isMuted(settings)) return '';
  if (settings.mutedUntil === 'forever') return 'Muted until you turn it back on.';
  const until = new Date(settings.mutedUntil);
  return `Muted until ${isSameDay(until, new Date()) ? '' : 'tomorrow '}${clock(until)}.`;
}

export default function NotificationSettings({ notifications }) {
  const styles = useStyles(makeStyles);
  const { settings, problem, busy, available } = notifications;
  const [volume, setVolume] = useState(settings.volume);
  // What Android allows. Asked again when we come back from its settings (the app was in the background).
  const [allowed, setAllowed] = useState(notificationsAllowed);
  const [fillScreen, setFillScreen] = useState(canFillScreen);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      setAllowed(notificationsAllowed());
      setFillScreen(canFillScreen());
    });
    return () => subscription.remove();
  }, []);

  return (
    <View>
      <Title>Notifications</Title>
      {available ? (
        <CheckRow
          checked={settings.push === true} disabled={busy}
          label="Notifications on this phone when the app is closed"
          onPress={() => notifications.setPush(!settings.push)}
        />
      ) : (
        <Help>This server isn't set up for notifications to the app.</Help>
      )}
      <Help>
        DMs, mentions, friend requests and calls. Not while you're looking at the chat on another device,
        or on Do Not Disturb.
      </Help>
      {problem ? <Text style={styles.error}>{problem}</Text> : null}
      {settings.push && !allowed ? (
        <View style={styles.warning}>
          <Help>Notifications are turned off for ChatApp in Android's settings, so none will show.</Help>
          <Button label="Open Android's settings" small secondary onPress={openNotificationSettings} />
        </View>
      ) : null}
      {settings.push && allowed && !fillScreen ? (
        <View style={styles.warning}>
          <Help>
            With the phone locked, a call can't show its call screen (who's calling, Accept, Decline): Android
            only allows that when you let it ("Full screen notifications"). Calls still ring as a notification.
          </Help>
          <Button label="Allow it" small secondary onPress={openFillScreenSettings} />
        </View>
      ) : null}

      <Heading>While the app is open</Heading>
      <CheckRow checked={settings.sound} label="Sound" onPress={() => notifications.setSound(!settings.sound)} />
      <CheckRow
        checked={settings.banner} label="A banner at the top for messages in other chats"
        onPress={() => notifications.setBanners(!settings.banner)}
      />
      <View style={styles.sliderRow}>
        <Text style={styles.sliderLabel}>Volume</Text>
        <View style={styles.slider}>
          <Slider
            value={volume} min={0} max={100} step={5}
            onChange={setVolume}
            onDone={(value) => {
              notifications.setVolume(value);
              notifications.playPing();  // let go: hear it (the web page's "change")
            }}
          />
        </View>
        <Text style={styles.sliderValue}>{volume}%</Text>
      </View>

      <Heading>Mute notifications</Heading>
      <Choices
        // (The choice that muted it, while that lasts: once a timed one is over, Off.)
        choices={MUTE_CHOICES} value={isMuted(settings) ? settings.muteChoice : 'off'}
        onPick={notifications.setMute}
      />
      <Help>No sound, no notifications; the red numbers still show.</Help>
      {isMuted(settings) ? <Text style={styles.muted}>{muteText(settings)}</Text> : null}
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, marginBottom: 4 },
  checkText: { flex: 1, color: colors.text, fontSize: size(15.2) },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  warning: { gap: 8, marginTop: 10 },
  error: { marginTop: 8, color: colors.red, fontSize: size(13.6) },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  sliderLabel: { color: colors.textSoft, fontSize: size(13.6) },
  slider: { flex: 1 },
  sliderValue: { width: 48, textAlign: 'right', color: colors.textMuted, fontSize: size(14.4) },
  muted: { marginTop: 6, color: colors.textSoft, fontSize: size(13.6) },
});
