// The pieces calls are drawn with, on the Lounge page (LoungeScreen.js) and in a DM's call banner
// (CallBanner.js): the web page's .call-tile, .call-round buttons and fitTiles (rooms.js).
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoTrack } from '@livekit/react-native';
import Icon from './Icon';
import { Avatar } from './people';
import { Sheet, SheetItem } from './Sheet';
import { SHARE_HEIGHTS, screenShortSide } from './voice';
import Slider from './Slider';
import { useStyles, useTheme } from './theme';

const TILE_GAP = 8;  // the space between tiles (rooms.js's TILE_GAP)

// A round button (.call-round): kind "off" (red: muted), "on" (green: camera on), "end" (red: leave),
// or nothing (grey).
export function RoundButton({ icon, label, onPress, kind }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const background = { off: styles.red, end: styles.red, on: styles.green }[kind];
  return (
    <Pressable
      onPress={onPress} accessibilityLabel={label} hitSlop={4}
      style={({ pressed }) => [styles.round, background, pressed && !background && styles.roundPressed, pressed && background && styles.dim]}
    >
      <Icon name={icon} size={22} color={kind ? '#ffffff' : colors.icon} />
    </Pressable>
  );
}

// The green "Join call" / "Join Lounge" pill (#call-panel-join, #lounge-join).
export function JoinButton({ label, icon, onPress }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.join, pressed && styles.dim]}>
      <Icon name={icon} size={18} color="#ffffff" />
      <Text style={styles.joinText}>{label}</Text>
    </Pressable>
  );
}

// The tiles of a call, from who's in it. members: the server's list ({id, muted, deafened}) of everyone
// in the call, us included if we are; people: voice.callPeople() (LiveKit's view: cameras and screens),
// empty unless we're in it. extra(id): more for a tile ({away, note}). Screens first (only while we're
// in the call, like the web page), then us, then the others.
export function makeTiles({ members, people, meId, inCall, alwaysMe, extra = () => ({}) }) {
  const byId = Object.fromEntries(people.map((person) => [person.id, person]));
  const tiles = [];
  if (inCall) {
    for (const person of people) {
      if (person.screen) tiles.push({ key: `screen:${person.id}`, id: person.id, screen: person.screen, isMe: person.isMe });
    }
  }
  const state = (id) => members.find((member) => member.id === id) ?? {};
  const ids = members.map((member) => member.id);
  if (alwaysMe && !ids.includes(meId)) ids.unshift(meId);
  ids.sort((a, b) => (a === meId ? -1 : b === meId ? 1 : 0));  // us first
  for (const id of ids) {
    const person = byId[id];
    tiles.push({
      key: `user:${id}`, id, isMe: id === meId,
      video: inCall ? person?.camera ?? null : null,
      muted: state(id).muted, deafened: state(id).deafened,
      ...extra(id),
    });
  }
  return tiles;
}

// One tile: a camera filling it (or a screen fitted inside it, on black), else the picture in the middle;
// the name (with the mic-off or headphone-off icon) in the corner, and a green ring while they talk.
// onLongPress: the user menu (the web page's right-click on a tile).
export function CallTile({ tile, user, width, speaking, facing, onPress, onLongPress }) {
  const styles = useStyles(makeStyles);
  const height = (width * 9) / 16;
  const name = user?.name ?? '?';
  const label = tile.screen ? (tile.isMe ? 'Your screen' : `${name}'s screen`) : (tile.note || name);
  const stateIcon = tile.screen || tile.note ? null : tile.deafened ? 'headphone-off' : tile.muted ? 'mic-off' : null;
  // Our own camera mirrored while it faces us (like a mirror; others see it the right way round).
  const mirror = tile.isMe && !tile.screen && facing === 'user';
  const pictureSize = Math.max(32, Math.min(80, Math.round(height * 0.45)));
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={[styles.tile, tile.screen && styles.screenTile, { width, height }]}>
      {tile.screen || tile.video ? (
        // The whole picture, never cut off ("contain", like the web page's .tile-video): a phone's camera is
        // upright, and "cover" blew it up to the tile's width and cropped most of it away.
        <VideoTrack
          trackRef={tile.screen || tile.video} style={StyleSheet.absoluteFill} objectFit="contain" mirror={mirror}
        />
      ) : (
        <View style={tile.away && styles.away}><Avatar user={user} size={pictureSize} /></View>
      )}
      <View style={styles.name}>
        {stateIcon ? <Icon name={stateIcon} size={14} color="#ffffff" /> : null}
        <Text numberOfLines={1} style={styles.nameText}>{label}</Text>
      </View>
      {speaking && !tile.screen ? <View pointerEvents="none" style={styles.ring} /> : null}
    </Pressable>
  );
}

// The tiles, as big as they can be in the space they have (rooms.js, fitTiles): for each number of
// columns, how wide can a 16:9 tile be before the row is wider than the area or the rows are taller than
// it? The biggest wins. A tap on a tile opens it big (FocusView), a long press their user menu (onUserMenu).
export function TileGrid({ tiles, voice, connection, style, onUserMenu }) {
  const styles = useStyles(makeStyles);
  const [area, setArea] = useState(null);
  const [focused, setFocused] = useState(null);  // the key of the tile shown big
  let width = 0;
  if (area) {
    for (let columns = 1; columns <= tiles.length; columns++) {
      const rows = Math.ceil(tiles.length / columns);
      const byWidth = (area.width - (columns - 1) * TILE_GAP) / columns;
      const byHeight = ((area.height - (rows - 1) * TILE_GAP) / rows) * 16 / 9;
      width = Math.max(width, Math.min(byWidth, byHeight));
    }
  }
  const big = tiles.find((tile) => tile.key === focused);
  return (
    <View style={[styles.grid, style]} onLayout={(event) => setArea(event.nativeEvent.layout)}>
      {area ? tiles.map((tile) => (
        <CallTile
          key={tile.key} tile={tile} user={connection.users[tile.id]} width={Math.floor(width)}
          speaking={voice.speaking.has(tile.id)} facing={voice.facing} onPress={() => setFocused(tile.key)}
          onLongPress={onUserMenu ? () => onUserMenu(tile.id) : undefined}
        />
      )) : null}
      {big ? (
        <FocusView
          tile={big} user={connection.users[big.id]} speaking={voice.speaking.has(big.id)}
          facing={voice.facing} onClose={() => setFocused(null)}
          voice={big.screen && !big.isMe && voice.screenHasSound(big.id) ? voice : null}
          onLongPress={onUserMenu ? () => onUserMenu(big.id) : undefined}
        />
      ) : null}
    </View>
  );
}

// A tile over the whole screen, on black (the web page's focus and fullscreen in one: a phone's screen is
// small). A tap or the back button closes it. voice: given for a shared screen with sound, which then gets
// its volume slider under it (the web page's makeScreenVolume).
export function FocusView({ tile, user, speaking, facing, onClose, voice, onLongPress }) {
  const styles = useStyles(makeStyles);
  const [size, setSize] = useState(null);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.focus} onPress={onClose} onLayout={(event) => setSize(event.nativeEvent.layout)}>
        {size ? (
          <CallTile
            tile={tile} user={user} speaking={speaking} facing={facing} onPress={onClose} onLongPress={onLongPress}
            width={Math.min(size.width - 16, ((size.height - 16) * 16) / 9)}
          />
        ) : null}
        {voice ? <ScreenVolume voice={voice} id={tile.id} /> : null}
      </Pressable>
    </Modal>
  );
}

function ScreenVolume({ voice, id }) {
  const styles = useStyles(makeStyles);
  const [percent, setPercent] = useState(voice.screenVolume(id));
  return (
    // (A Pressable without onPress: touching the slider doesn't close the view.)
    <Pressable style={styles.screenVolume}>
      <Icon name="volume-2" size={20} color="#ffffff" />
      <View style={styles.screenSlider}>
        <Slider
          value={percent} min={0} max={200} step={5}
          onChange={(value) => {
            setPercent(value);
            voice.setScreenVolume(id, value);
          }}
        />
      </View>
      <Text style={styles.screenVolumeText}>{percent}%</Text>
    </Pressable>
  );
}

// Where the sound goes: a button showing the current place, which opens a list of the others.
const OUTPUT_NAMES = { speaker: 'Speaker', earpiece: 'Phone (earpiece)', headset: 'Headphones', bluetooth: 'Bluetooth' };
const OUTPUT_ICONS = { speaker: 'volume-2', earpiece: 'ear', headset: 'headphones', bluetooth: 'bluetooth' };

export function OutputButton({ voice }) {
  const [open, setOpen] = useState(false);
  // (Android's own choice until one is picked: the first of Bluetooth, headphones, speaker that's there.)
  const current = voice.output ?? ['bluetooth', 'headset', 'speaker'].find((id) => voice.outputs.includes(id)) ?? 'speaker';
  return (
    <>
      <RoundButton
        icon={OUTPUT_ICONS[current] ?? 'volume-2'} label="Where the sound goes"
        onPress={() => {
          voice.refreshOutputs();
          setOpen(true);
        }}
      />
      {open ? (
        <Sheet title="Play the call on" onClose={() => setOpen(false)}>
          {voice.outputs.filter((id) => OUTPUT_NAMES[id]).map((id) => (
            <SheetItem
              key={id} icon={id === current ? 'check' : OUTPUT_ICONS[id]} label={OUTPUT_NAMES[id]}
              onPress={() => {
                voice.selectOutput(id);
                setOpen(false);
              }}
            />
          ))}
        </Sheet>
      ) : null}
    </>
  );
}

// The screen share's quality menu (the web page's #share-menu), opened by the share buttons (voice.toggleShare):
// the size, the last one ticked; bigger than the screen itself greyed out (720p always works). No frame rate:
// a phone's screen is always recorded at 30 fps (react-native-webrtc).
export function ShareMenu({ voice }) {
  if (!voice.shareMenu) return null;
  const full = screenShortSide();
  const megabits = { 720: 2.5, 1080: 5, 1440: 8 };
  const allowed = SHARE_HEIGHTS.filter((height) => height <= full || height === 720);
  // The last one picked, or the biggest this screen allows.
  const chosen = allowed.includes(voice.settings.shareHeight) ? voice.settings.shareHeight : allowed[allowed.length - 1];
  return (
    <Sheet title={`Share your screen (yours: ${full}p)`} onClose={voice.closeShareMenu}>
      {allowed.map((height) => (
        <SheetItem
          key={height} icon={height === chosen ? 'check' : 'monitor-up'}
          label={`${height}p · about ${megabits[height]} Mbit/s for each person watching`}
          onPress={() => voice.startShare(height)}
        />
      ))}
    </Sheet>
  );
}

// The call's error, with why (voice.js's status.detail), under the tiles of the banner and the Lounge page.
export function callError(voice) {
  if (voice.status?.kind !== 'error') return null;
  return voice.status.detail ? `${voice.status.text}: ${voice.status.detail}` : voice.status.text;
}

// The buttons while we're in a call: mute, camera (and flip while it's on), share, where the sound goes,
// and leave. (The web page's #call-buttons and .lounge-buttons; no fullscreen: a tile opens big instead.)
export function CallControls({ voice, leaveLabel }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.controls}>
      <RoundButton
        icon={voice.muted ? 'mic-off' : 'mic'} label={voice.muted ? 'Unmute' : 'Mute'}
        kind={voice.muted ? 'off' : undefined} onPress={voice.toggleMute}
      />
      <RoundButton
        icon={voice.camera ? 'video' : 'video-off'} label={voice.camera ? 'Turn off camera' : 'Turn on camera'}
        kind={voice.camera ? 'on' : undefined} onPress={voice.toggleCamera}
      />
      {voice.camera ? <RoundButton icon="switch-camera" label="Switch camera" onPress={voice.flipCamera} /> : null}
      <RoundButton
        icon="monitor-up" label={voice.sharing ? 'Stop sharing' : 'Share your screen'}
        kind={voice.sharing ? 'on' : undefined} onPress={voice.toggleShare}
      />
      <OutputButton voice={voice} />
      <RoundButton icon="phone-off" label={leaveLabel} kind="end" onPress={voice.leave} />
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  round: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgPanel,
  },
  roundPressed: { backgroundColor: colors.bgHover },
  red: { backgroundColor: colors.buttonRed },
  green: { backgroundColor: colors.buttonGreen },
  dim: { opacity: 0.8 },
  join: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 20,
    borderRadius: 24, backgroundColor: colors.buttonGreen,
  },
  joinText: { color: '#ffffff', fontSize: size(15.2) },
  // .call-tile: radius 12, the panel colour, everything in the middle.
  tile: {
    borderRadius: 12, backgroundColor: colors.bgPanel, alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  screenTile: { backgroundColor: '#000000' },
  away: { opacity: 0.35 },  // .call-tile.away: not in the call (yet)
  // .tile-name: a dark band in the bottom left corner, white text in every theme.
  name: {
    position: 'absolute', left: 8, bottom: 8, maxWidth: '85%', flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 2, paddingHorizontal: 8, borderRadius: 6, backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  nameText: { color: '#ffffff', fontSize: size(13.6), flexShrink: 1 },
  // .call-tile.speaking::after: a green ring drawn on top, so a video can't cover it.
  ring: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 12, borderWidth: 3, borderColor: colors.green },
  grid: {
    flex: 1, alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center',
    alignContent: 'center', gap: TILE_GAP,
  },
  focus: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  screenVolume: {
    position: 'absolute', left: 24, right: 24, bottom: 48, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  screenSlider: { flex: 1 },
  screenVolumeText: { width: 44, textAlign: 'right', color: '#ffffff', fontSize: size(13.6) },
  controls: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 12 },
});
