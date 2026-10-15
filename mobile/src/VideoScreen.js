// A video in a popup (the seasonal easter egg's, and one sent in a chat): as big as fits (92% of the width,
// 80% of the height, room left for the controls), playing at once, with our own control bar right under it
// (the web page's browser player has the same parts): a time bar to skip, play/pause, the time, mute and
// volume. Android's own controls were a big overlay (at the bottom of the screen, in full screen) with no
// volume. A tap on the video plays or pauses; × or a tap beside it closes it.
//
// expo-video's player (Android's ExoPlayer) downloads with its own HTTP client, so it gets the login
// cookie as a header (modules/cookies; uploads and seasonal videos need a login).
import { useEventListener } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { getCookie } from '../modules/cookies';
import Icon from './Icon';
import Slider from './Slider';
import { SERVER } from './config';
import { useStyles } from './theme';

// "1:05" from seconds.
function minutes(seconds) {
  const whole = Math.floor(seconds || 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// path: the video's address on the server ("/uploads/<id>", "/seasonal/halloween.mp4"). startVolume:
// 0 to 1 (the seasonal ones start at 0.3: they're loud). onClose: closes it.
export default function VideoScreen({ path, startVolume = 1, onClose }) {
  const styles = useStyles(makeStyles);
  const screen = useWindowDimensions();
  const source = useMemo(() => {
    const cookie = getCookie(SERVER);
    return { uri: SERVER + path, headers: cookie ? { Cookie: cookie } : undefined };
  }, [path]);
  const player = useVideoPlayer(source, (created) => {
    created.volume = startVolume;
    created.timeUpdateEventInterval = 0.25;  // "timeUpdate" four times a second, for the time bar
    created.play();
  });
  // What the bar shows, kept up to date by the player's events.
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(startVolume);
  const [muted, setMuted] = useState(false);
  const seeking = useRef(false);  // the time bar is being dragged: the player's times wait
  // The video's length, once the player knows it. Until then Android reports a huge negative number
  // ("unknown"), so only a real length counts.
  function knowDuration(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) setDuration(seconds);
  }
  useEventListener(player, 'playingChange', ({ isPlaying }) => setPlaying(isPlaying));
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (!seeking.current) setTime(currentTime);
    knowDuration(player.duration);
  });
  useEventListener(player, 'volumeChange', (event) => setVolume(event.volume));
  useEventListener(player, 'mutedChange', (event) => setMuted(event.muted));
  // At the end it stops (no loop); ▶ then starts it again from the beginning.
  function playOrPause() {
    if (playing) {
      player.pause();
      return;
    }
    if (duration && time >= duration - 0.3) player.currentTime = 0;
    player.play();
  }
  const [natural, setNatural] = useState(null);  // the video's own {width, height}, once loaded
  useEventListener(player, 'sourceLoad', (event) => {
    const size = event.availableVideoTracks[0]?.size;
    if (size?.width && size?.height) setNatural(size);
    knowDuration(event.duration);
  });

  const room = { width: screen.width * 0.92, height: screen.height * 0.8 - 90 };
  let size = { width: room.width, height: room.width * 9 / 16 };  // until we know its shape
  if (natural) {
    const scale = Math.min(room.width / natural.width, room.height / natural.height);
    size = { width: natural.width * scale, height: natural.height * scale };
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} navigationBarTranslucent statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* The dark area around the video closes it too: a layer of its own behind the video, not around
            it (a Pressable around the video took every touch, so the player never showed its controls). */}
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.box}>
          <View>
            <VideoView player={player} style={size} nativeControls={false} contentFit="contain" />
            {/* A see-through button over the video: Android's video view keeps taps for itself (see
                MessageText.js's VideoAttachment). */}
            <Pressable onPress={playOrPause} style={[styles.cover, size]} accessibilityLabel={playing ? 'Pause' : 'Play'} />
            {/* Paused: a round ▶ in the middle (like the one on a chat's video). It lets taps through to the
                button under it (pointerEvents "none"). */}
            {playing ? null : (
              <View style={[styles.cover, size, styles.middle]} pointerEvents="none">
                <View style={styles.playButton}>
                  <Icon name="play" size={28} color="#ffffff" />
                </View>
              </View>
            )}
            {/* A round × (#season-close). Inside the video's corner, not half outside it as on the web page:
                Android ignores taps outside a parent's edges. */}
            <Pressable onPress={onClose} style={styles.close} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={18} color="#ffffff" />
            </Pressable>
          </View>
          {/* The bar: the time bar on top; ▶/⏸, the time, and the sound under it. */}
          <View style={styles.controls}>
            {/* In a row: the Slider takes the free room with flex: 1, which in this column would be height. */}
            <View style={styles.timeBar}>
              <Slider
                value={time} min={0} max={duration || 1} step={0.1}
                onChange={(value) => {
                  seeking.current = true;
                  setTime(value);
                }}
                onDone={(value) => {
                  player.currentTime = value;
                  seeking.current = false;
                }}
              />
            </View>
            <View style={styles.row}>
              <Pressable onPress={playOrPause} hitSlop={8} accessibilityLabel={playing ? 'Pause' : 'Play'}>
                <Icon name={playing ? 'pause' : 'play'} size={22} color="#ffffff" />
              </Pressable>
              <Text style={styles.time}>{minutes(time)} / {minutes(duration)}</Text>
              <Pressable onPress={() => { player.muted = !muted; }} hitSlop={8} accessibilityLabel={muted ? 'Unmute' : 'Mute'}>
                <Icon name={muted || volume === 0 ? 'volume-x' : 'volume-2'} size={22} color="#ffffff" />
              </Pressable>
              <View style={styles.volume}>
                <Slider
                  value={muted ? 0 : Math.round(volume * 100)} min={0} max={100} step={1}
                  onChange={(value) => {
                    player.volume = value / 100;
                    if (muted && value > 0) player.muted = false;
                  }}
                />
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// chat.css's #season-dialog: black, rounded, over a darker backdrop.
const makeStyles = (colors, size) => StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.8)' },
  // (Its edges spelled out: StyleSheet.absoluteFill did nothing in RN 0.86, see Drawer.js.)
  backdropTap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // The video with its bar under it, in one black box with round corners.
  box: { borderRadius: 8, overflow: 'hidden', backgroundColor: '#000000' },
  cover: { position: 'absolute', top: 0, left: 0 },
  middle: { alignItems: 'center', justifyContent: 'center' },
  // The same round button as on a chat's video (MessageText.js).
  playButton: {
    width: 56, height: 56, borderRadius: 28, paddingLeft: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.6)', alignItems: 'center', justifyContent: 'center',
  },
  controls: { paddingHorizontal: 10, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 6 },
  time: { flex: 1, color: '#ffffff', fontSize: size(13.6), fontVariant: ['tabular-nums'] },
  timeBar: { flexDirection: 'row' },
  volume: { width: 100, flexDirection: 'row' },
  close: {
    position: 'absolute', top: 8, right: 8, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgDarkest,
  },
});
