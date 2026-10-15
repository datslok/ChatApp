// Calls: the Lounge, and calls in DMs and groups (the web page's voice.js, rooms.js and video.js).
//
// How a call works: the chat server never carries any sound. We ask it for a ticket (/voice-token, a
// signed JWT saying "user 7 may join room X"), show that to the LiveKit server, and from then on our
// microphone and camera go to LiveKit, which passes everyone's on to everyone else (WebRTC, the same
// real-time audio and video as in browsers; here @livekit/react-native-webrtc, Google's WebRTC built for
// Android). The chat connection only says who's where ("voice", "voice_members", "dm_call") and does the
// ringing ("call", "call_answer", "call_cancel", "call_ended"), exactly as for the web page.
//
// useVoice() keeps all of it; App.js calls it once and hands it to the screens that draw calls (the
// sidebar's Voice list and voice bar, the Lounge page, a DM's call banner, the ringing popup, Settings).
// What differs from the web page, for phone reasons: no RNNoise, noise gate or push to talk (those are
// Web Audio, which React Native doesn't have: Android's own noise suppression instead), the sound goes to
// the speaker, the earpiece, headphones or Bluetooth (`outputs`), the camera can flip, and a shared screen
// has no sound (react-native-webrtc can't record the phone's sound).
import { useEffect, useRef, useState } from 'react';
import { AppState, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform, Vibration } from 'react-native';
import { Room, RoomEvent, Track, VideoPresets43 } from 'livekit-client';
import { AndroidAudioTypePresets, AudioSession } from '@livekit/react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { SERVER } from './config';
import { chatLabel } from './chats';
import { phonePushOn } from './notifications';
import {
  addHangUpListener, playCue, setAiNoiseSuppression, setMicVolume, startCallService, stopCallService,
} from '../modules/call-service';
import { clearCallNotification, isCallNotificationShowing } from '../modules/push';

export const LOUNGE = 'voice:lounge';  // the Lounge page's key among the chats' (the web page's LOUNGE)
export const LOUNGE_ROOM = 'lounge';   // its LiveKit room

// Talking: louder than -50 dB (like the web page's SPEAKING_LINE), and the ring stays 0.3 s after.
const SPEAKING_LINE = 10 ** (-50 / 20);  // as a level between 0 and 1 (what LiveKit's measuring gives)
const SPEAKING_HOLD_MS = 300;

// The camera: 4:3, the shape of a phone's camera sensor (asking for 16:9 made it cut the sides off),
// 960x720 (720x960 held upright). Sent as H.264, which the phone's own video chip encodes (VP8 was
// done in software by libvpx, and went blurry now and then), up to 1.7 Mbit/s at 30 fps. LiveKit adds
// two smaller copies (simulcast) for small tiles and slow connections.
const CAMERA_CAPTURE = { resolution: VideoPresets43.h720.resolution };
const CAMERA_PUBLISH = { videoCodec: 'h264', videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 } };

// ----- Settings → Voice & audio and Video, kept on the phone (like the web page's localStorage
// "voiceSettings", "voicePersonVolumes" and "voiceScreenVolumes")

export const DEFAULT_VOICE_SETTINGS = {
  // Like the web page's: "on" (RNNoise, the AI one: keyboards, dogs, voices in the background; in our own
  // native code, MicProcessor.kt), "light" (Android's own, for fans and hum) or "off".
  noiseSuppression: 'on',
  micVolume: 100,          // our microphone, 0-200 % (MicProcessor.kt)
  outputVolume: 100,       // everyone else, 0-200 %
  personVolumes: {},       // {userId: percent}: each person's own volume (their profile's slider)
  screenVolumes: {},       // {userId: percent}: the sound of their shared screen
  camera: 'user',          // which camera turns on: "user" (the front one) or "environment" (the back)
  floatCorner: 'bottom-right',  // where the floating call window sits (CallFloat.js)
};

const settingsFile = new File(Paths.document, 'voice-settings.json');

function loadVoiceSettings() {
  try {
    if (settingsFile.exists) return { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(settingsFile.textSync()) };
  } catch {}
  return DEFAULT_VOICE_SETTINGS;
}

function saveVoiceSettings(settings) {
  try {
    if (!settingsFile.exists) settingsFile.create();
    settingsFile.write(JSON.stringify(settings));
  } catch {}
}

// ----- Sounds (the web page generates them; here they're files made by tools/make_call_sounds.py)

// The ringtone (someone calling us, before any call has started) is played as media, mixed with
// whatever plays, never pausing it.
setAudioModeAsync({ interruptionMode: 'mixWithOthers', shouldPlayInBackground: true }).catch(() => {});

let ringPlayer = null;
// The sounds during a call ("calling", "join", "leave") go to our call-service module instead, on the
// call's own sound channel: as media they waited seconds while Android switched into or out of call mode.
function playSound(name) {
  if (name !== 'ring') {
    playCue(name);
    return;
  }
  try {
    ringPlayer ??= createAudioPlayer(require('../assets/sounds/ring.wav'));
    ringPlayer.seekTo(0);
    ringPlayer.play();
  } catch {}
}

// ----- LiveKit's measuring of how loud a track is (what its useTrackVolume hook uses underneath)

// Its native module, straight: createVolumeProcessor attaches a "sink" to an audio track, which then
// reports the track's loudness (0..1) about 100 times a second as an "LK_VOLUME_PROCESSED" event.
const LiveKitNative = NativeModules.LivekitReactNativeModule;
const volumeEvents = LiveKitNative ? new NativeEventEmitter(LiveKitNative) : null;

async function askPermission(permission) {
  try {
    return (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

// connection: useConnection()'s. onOpenChatRef.current(key): open a chat (App.js's go), for Accept.
export function useVoice(connection, onOpenChatRef) {
  const [settings, setSettingsState] = useState(loadVoiceSettings);
  const [roomName, setRoomName] = useState(null);  // the room we're in (or joining), or null
  // The voice bar's first line: {text, kind}, kind "ok" (green), "waiting" (yellow) or "error" (red).
  const [status, setStatus] = useState(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [camera, setCamera] = useState(false);     // our camera is on
  const [facing, setFacing] = useState(settings.camera);  // which camera: "user" or "environment"
  const [sharing, setSharing] = useState(false);   // we're sharing our screen
  const [speaking, setSpeaking] = useState(new Set());  // ids of who's talking right now (us too)
  const [outputs, setOutputs] = useState([]);      // where the sound can go: "speaker", "earpiece", ...
  const [output, setOutput] = useState(null);      // where it goes now (null: Android's choice)
  // Calls in DMs and groups: our own still ringing (its key), one ringing for us ({channel, from, name}),
  // and a short note after ours ended unanswered ({channel, text}).
  const [outgoing, setOutgoingState] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [notice, setNotice] = useState(null);
  const [, setTick] = useState(0);  // a new number: something in the room changed, draw again

  // The newest values, for the handlers LiveKit and the timers call later (see connection.js on refs).
  const room = useRef(null);  // the LiveKit Room
  const latest = useRef({});
  latest.current = { settings, roomName, muted, deafened, outgoing, incoming, connection };
  const joinCount = useRef(0);       // each join's number: a join that was overtaken stops
  const processors = useRef({});     // LiveKit's volume measuring, by its tag: {tag, pcId, trackId, id}
  const lastLoud = useRef({});       // id -> when they were last louder than SPEAKING_LINE
  const mutedBeforeDeafen = useRef(false);
  const callingTimer = useRef(null);
  const ringTimer = useRef(null);
  const noticeTimer = useRef(null);
  // A call's Accept in its notification (App.js): the call to answer as soon as the server rings us for
  // it (it does as we connect), or null.
  const acceptWhenRung = useRef(null);
  const redraw = () => setTick((n) => n + 1);

  function setSettings(changes) {
    setSettingsState((old) => {
      const next = { ...old, ...changes };
      saveVoiceSettings(next);
      return next;
    });
  }

  // Someone's own volume (their profile's slider), in percent. Only those that aren't 100 are kept.
  // The same for the sound of someone's shared screen (the slider on their screen, opened big).
  const screenVolume = (id) => settings.screenVolumes[id] ?? 100;
  function setScreenVolume(id, percent) {
    const volumes = { ...settings.screenVolumes, [id]: percent };
    if (percent === 100) delete volumes[id];
    setSettings({ screenVolumes: volumes });
  }
  // Does their screen share come with sound (shared from a computer: a phone can't send it)?
  function screenHasSound(id) {
    const participant = room.current?.remoteParticipants.get(String(id));
    return !!participant?.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
  }
  const personVolume = (id) => settings.personVolumes[id] ?? 100;
  function setPersonVolume(id, percent) {
    const volumes = { ...settings.personVolumes, [id]: percent };
    if (percent === 100) delete volumes[id];
    setSettings({ personVolumes: volumes });
  }

  // ----- Telling the server where we are

  function sendVoiceState(changes = {}) {
    const now = { ...latest.current, ...changes };
    // (Only once LiveKit has let us in: then we're really there. Leaving says room null.)
    const inRoom = room.current && room.current.state === 'connected' ? now.roomName : null;
    connection.sendVoice({ room: inRoom, muted: now.muted, deafened: now.deafened });
  }

  // ----- Volumes: everyone's own (their profile), times Others' volume, all 0 when deafened

  function applyVolume(participant) {
    const { settings: s, deafened: deaf } = latest.current;
    const base = deaf ? 0 : s.outputVolume / 100;
    const id = participant.identity;
    participant.setVolume(base * (s.personVolumes[id] ?? 100) / 100, Track.Source.Microphone);
    participant.setVolume(base * (s.screenVolumes[id] ?? 100) / 100, Track.Source.ScreenShareAudio);
  }

  function applyAllVolumes() {
    for (const participant of room.current?.remoteParticipants.values() ?? []) applyVolume(participant);
  }

  useEffect(applyAllVolumes, [settings, deafened]);

  // ----- Who's talking (the web page's "Who's talking")

  function measure(track, id) {
    const media = track?.mediaStreamTrack;
    if (!LiveKitNative || !media) return;
    const pcId = media.remote ? media._peerConnectionId : -1;  // (-1: our own microphone, react-native-webrtc's rule)
    try {
      const tag = LiveKitNative.createVolumeProcessor(pcId, media.id);
      processors.current[tag] = { tag, pcId, trackId: media.id, id: String(id), sid: track.sid };
    } catch {}
  }

  function stopMeasuring(sid) {
    for (const processor of Object.values(processors.current)) {
      if (sid !== undefined && processor.sid !== sid) continue;
      try {
        LiveKitNative.deleteVolumeProcessor(processor.tag, processor.pcId, processor.trackId);
      } catch {}
      delete processors.current[processor.tag];
    }
  }

  useEffect(() => {
    if (!volumeEvents) return undefined;
    const subscription = volumeEvents.addListener('LK_VOLUME_PROCESSED', (event) => {
      const processor = processors.current[event.id];
      if (processor && event.volume > SPEAKING_LINE) lastLoud.current[processor.id] = Date.now();
    });
    // Every 50 ms (like the web page's checkSpeaking): who was loud in the last 0.3 s. Redraws only when
    // that changes. Our own ring only while we're unmuted (the measuring hears the microphone itself).
    const timer = setInterval(() => {
      const now = Date.now();
      const me = String(latest.current.connection.me?.id);
      const talking = new Set();
      for (const [id, when] of Object.entries(lastLoud.current)) {
        if (now - when > SPEAKING_HOLD_MS) continue;
        if (id === me && latest.current.muted) continue;
        talking.add(Number(id));
      }
      setSpeaking((old) => (old.size === talking.size && [...talking].every((id) => old.has(id)) ? old : talking));
    }, 50);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);

  // ----- The microphone's processing: Android's echo cancelling and automatic volume always; then either
  // RNNoise ("on", in MicProcessor.kt) or Android's own noise suppression ("light", one of the constraints
  // here), or neither ("off"); and the mic volume. Like the web page, which uses the browser's own
  // suppression only when RNNoise is off.

  function micOptions(noise = latest.current.settings.noiseSuppression) {
    return { echoCancellation: true, noiseSuppression: noise === 'light', autoGainControl: true };
  }

  // The native half (MicProcessor.kt) always has the newest settings: at the start, and after each change.
  useEffect(() => {
    setAiNoiseSuppression(settings.noiseSuppression === 'on');
    setMicVolume(settings.micVolume);
  }, [settings.noiseSuppression, settings.micVolume]);

  // Noise suppression changed in Settings: saved, and during a call the microphone opens again with it
  // (restartTrack: the same track, so it stays in the call).
  async function setNoiseSuppression(noise) {
    setSettings({ noiseSuppression: noise });
    const track = room.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    try {
      await track?.restartTrack(micOptions(noise));
    } catch {}
  }

  // ----- Joining and leaving

  // roomName: "lounge", a DM's or group's key. Leaves the room we're in first.
  async function join(name) {
    if (room.current) await leave();
    const myJoin = ++joinCount.current;
    const stillMine = () => myJoin === joinCount.current;
    setRoomName(name);
    latest.current.roomName = name;
    setStatus({ text: 'Connecting…', kind: 'waiting' });

    // The microphone's permission (Android asks once; without it we listen only, muted).
    const micAllowed = await askPermission(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (!stillMine()) return;
    if (!micAllowed && !latest.current.muted) {
      setMuted(true);
      latest.current.muted = true;
    }
    // ...and to show notifications (Android 13+): without it the call notification below is hidden.
    // (The call works either way; Android asks once, and remembers the answer.)
    if (Platform.Version >= 33) await askPermission(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (!stillMine()) return;
    // The foreground service, while we're on screen (Android refuses it later): the call keeps going
    // with the phone locked, and its notification says so.
    startCallService(name === LOUNGE_ROOM ? 'In voice' : 'In a call', labelOf(name), false).catch(() => {});

    try {
      // The sound as for a phone call ("communication": echo cancelling, the voice call volume), to
      // Bluetooth or headphones if there are some, else the speaker (never the earpiece by itself).
      await AudioSession.configureAudio({
        android: {
          preferredOutputList: ['bluetooth', 'headset', 'speaker'],
          audioTypeOptions: AndroidAudioTypePresets.communication,
        },
      });
      await AudioSession.startAudioSession();
      setOutput(null);
      AudioSession.getAudioOutputs().then(setOutputs).catch(() => {});

      // The camera starts as the one picked in Settings → Video (flipping in a call doesn't change that).
      const startFacing = latest.current.settings.camera;
      setFacing(startFacing);
      const lk = new Room({
        adaptiveStream: true,  // others' videos come in the size they're drawn, and not at all when hidden
        dynacast: true,        // and ours is only sent in the sizes someone watches
        audioCaptureDefaults: micOptions(),
        videoCaptureDefaults: { ...CAMERA_CAPTURE, facingMode: startFacing },
      });
      room.current = lk;
      watchRoom(lk);

      // The ticket: our login cookie goes along by itself.
      const response = await fetch(`${SERVER}/voice-token?room=${encodeURIComponent(name)}`);
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof answer.detail === 'string' ? answer.detail : "Couldn't join.");
      await lk.connect(answer.url, answer.token);
      if (!stillMine() || room.current !== lk) {  // left (or joined elsewhere) meanwhile
        lk.disconnect();
        return;
      }
      lk.wasIn = true;  // (from now on a Disconnected means we were thrown out: see watchRoom)
      const ringing = latest.current.outgoing === name;
      setStatus(ringing ? { text: 'Calling…', kind: 'waiting' } : { text: 'Voice connected', kind: 'ok' });
      sendVoiceState({ roomName: name });
      if (!ringing) playSound('join');
      if (!latest.current.muted) await lk.localParticipant.setMicrophoneEnabled(true);
      applyAllVolumes();
      redraw();
    } catch (error) {
      if (!stillMine()) return;
      setStatus({ text: error?.message || "Couldn't connect.", kind: 'error' });
      // (Stay "in" the room, showing the error, until Leave: like the web page.)
      const failed = room.current;
      room.current = null;
      failed?.disconnect();
      AudioSession.stopAudioSession().catch(() => {});
      stopCallService().catch(() => {});
      if (latest.current.outgoing === name) {
        connection.cancelCall(name);  // we couldn't get in: stop their ringing
        setOutgoing(null);
      }
    }
  }

  // LiveKit's events: anything that changes what the call looks like draws it again.
  function watchRoom(lk) {
    lk.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === 'audio') applyVolume(participant);
      if (track.source === Track.Source.Microphone) measure(track, participant.identity);
      redraw();
    });
    lk.on(RoomEvent.TrackUnsubscribed, (track) => {
      stopMeasuring(track.sid);
      redraw();
    });
    lk.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === Track.Source.Microphone) measure(publication.track, lk.localParticipant.identity);
      redraw();
    });
    lk.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      stopMeasuring(publication.track?.sid);
      // (Stopped from outside our buttons too: Android's own Stop for a screen share.)
      if (publication.source === Track.Source.ScreenShare) setSharing(false);
      redraw();
    });
    for (const event of [RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished]) {
      lk.on(event, redraw);
    }
    // Someone came or went: a cue in DMs and groups (not in the Lounge, where people come and go).
    lk.on(RoomEvent.ParticipantConnected, () => {
      if (latest.current.roomName !== LOUNGE_ROOM) playSound('join');
      redraw();
    });
    lk.on(RoomEvent.ParticipantDisconnected, (participant) => {
      delete lastLoud.current[participant.identity];
      if (latest.current.roomName !== LOUNGE_ROOM) playSound('leave');
      redraw();
    });
    lk.on(RoomEvent.Reconnecting, () => setStatus({ text: 'Reconnecting…', kind: 'waiting' }));
    lk.on(RoomEvent.Reconnected, () => setStatus({ text: 'Voice connected', kind: 'ok' }));
    // Thrown out (the server went away, we were banned): as if we had left. (Not while still joining:
    // a failed join says why in its own catch.)
    lk.on(RoomEvent.Disconnected, () => {
      if (room.current === lk && lk.wasIn) leave();
    });
  }

  async function leave() {
    joinCount.current += 1;  // (a join still on its way stops)
    const lk = room.current;
    const name = latest.current.roomName;
    room.current = null;
    if (name && latest.current.outgoing === name) {
      connection.cancelCall(name);  // hung up before anyone answered
      setOutgoing(null);
    }
    if (lk) playSound('leave');
    stopMeasuring();
    lastLoud.current = {};
    setSpeaking(new Set());
    setRoomName(null);
    latest.current.roomName = null;
    setStatus(null);
    setCamera(false);
    setSharing(false);
    setOutputs([]);
    if (lk) {
      await lk.disconnect().catch(() => {});
      connection.sendVoice({ room: null, muted: latest.current.muted, deafened: latest.current.deafened });
    }
    AudioSession.stopAudioSession().catch(() => {});
    stopCallService().catch(() => {});
  }

  // Hang up in the call notification; and logging out leaves too.
  useEffect(() => {
    const subscription = addHangUpListener(() => leave());
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (connection.me === null && room.current) leave();
  }, [connection.me]);

  // The notification's text: where we are.
  function labelOf(name) {
    if (name === LOUNGE_ROOM) return 'Lounge';
    return chatLabel(name, latest.current.connection);
  }

  // ----- Mute and deafen (they work outside calls too, like the web page's panel buttons)

  async function setMicMuted(next) {
    setMuted(next);
    latest.current.muted = next;
    const lk = room.current;
    if (lk && lk.state === 'connected') {
      if (!next && !(await askPermission(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO))) {
        setMuted(true);
        latest.current.muted = true;
        return;
      }
      await lk.localParticipant.setMicrophoneEnabled(!next).catch(() => {});
    }
    sendVoiceState({ muted: next });
  }

  // Unmuting while deafened undeafens too (like Discord).
  function toggleMute() {
    if (latest.current.deafened && latest.current.muted) {
      setDeafened(false);
      latest.current.deafened = false;
      setMicMuted(false);
      return;
    }
    setMicMuted(!latest.current.muted);
  }

  // Deafened: nobody heard (all volumes 0) and ourselves muted; undeafening gives the mute back as it was.
  function toggleDeafen() {
    const next = !latest.current.deafened;
    setDeafened(next);
    latest.current.deafened = next;
    if (next) {
      mutedBeforeDeafen.current = latest.current.muted;
      setMicMuted(true);
    } else {
      setMicMuted(mutedBeforeDeafen.current);
    }
  }

  // ----- Camera and screen

  async function toggleCamera() {
    const lk = room.current;
    if (!lk || lk.state !== 'connected') return;
    const next = !camera;
    if (next && !(await askPermission(PermissionsAndroid.PERMISSIONS.CAMERA))) return;
    try {
      await lk.localParticipant.setCameraEnabled(next, next ? { ...CAMERA_CAPTURE, facingMode: facing } : undefined, CAMERA_PUBLISH);
      setCamera(next);
      // The service's types change with it (Android lets a foreground service use the camera only if it says so).
      startCallService(latest.current.roomName === LOUNGE_ROOM ? 'In voice' : 'In a call', labelOf(latest.current.roomName), next).catch(() => {});
    } catch {}
    redraw();
  }

  // Front <-> back: LiveKit opens the other camera in the same track (restartTrack), so it keeps going out.
  async function flipCamera() {
    const next = facing === 'user' ? 'environment' : 'user';
    setFacing(next);
    const track = room.current?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    try {
      await track?.restartTrack({ ...CAMERA_CAPTURE, facingMode: next });  // (the size too, or it'd be LiveKit's default)
    } catch {}
    redraw();
  }

  // Android first asks "Start recording or casting?" (its own popup); react-native-webrtc then runs its own
  // foreground service for it ("mediaProjection").
  async function toggleShare() {
    const lk = room.current;
    if (!lk || lk.state !== 'connected') return;
    try {
      await lk.localParticipant.setScreenShareEnabled(!sharing);
      setSharing(!sharing);
    } catch {
      setSharing(false);  // (said no in Android's popup)
    }
    redraw();
  }

  // ----- Where the sound goes

  async function refreshOutputs() {
    try {
      setOutputs(await AudioSession.getAudioOutputs());
    } catch {}
  }

  async function selectOutput(id) {
    try {
      await AudioSession.selectAudioOutput(id);
      setOutput(id);
    } catch {}
  }

  // ----- Calls in DMs and groups (the web page's rooms.js, "Calls")

  // Every change to `outgoing` goes through here, so however a ringing call ends, its sound stops.
  function setOutgoing(chat) {
    setOutgoingState(chat);
    latest.current.outgoing = chat;
    clearInterval(callingTimer.current);
    callingTimer.current = null;
    if (chat) {
      playSound('calling');
      callingTimer.current = setInterval(() => playSound('calling'), 1200);
    }
  }

  // The call button: join the call if one is going on, else ring the others and wait for them in it.
  async function startCall(chat) {
    if (latest.current.connection.dmCalls[chat]?.length) {
      join(chat);
      return;
    }
    setOutgoing(chat);
    connection.ring(chat);
    await join(chat);
  }

  function startRinging(call) {
    stopRinging();
    setIncoming(call);
    latest.current.incoming = call;
    // In the background with push on, the call's notification rings (modules/push): not twice.
    if (AppState.currentState !== 'active' && phonePushOn()) return;
    ringSounds();
  }

  // The ringtone and buzzing, until stopRinging. Not while the call's notification rings: Android repeats
  // its sound until the notification goes, even when the app is paused (as it may be over the lock
  // screen), which our timer wouldn't. Accept, Decline or the call ending takes it away.
  function ringSounds() {
    const call = latest.current.incoming;
    if (!call || ringTimer.current || isCallNotificationShowing(call.channel)) return;
    // "Do not disturb": the popup, but no sound or buzzing (like the web page's isMuted()).
    if (latest.current.connection.myPresence === 'dnd') return;
    playSound('ring');
    ringTimer.current = setInterval(() => playSound('ring'), 2000);
    Vibration.vibrate([0, 500, 1500], true);  // buzz half a second every 2 seconds, until stopped
  }

  // Back in the app with a call ringing and no notification ringing for it (it was swiped away, or push
  // is off): our turn.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') ringSounds();
    });
    return () => subscription.remove();
  }, []);

  // Accept in a ringing call's notification: answer it now if it's ringing here already, else as soon
  // as the server rings us for it (a few seconds, while we connect; not after its 30 s).
  function acceptFromNotification(channel) {
    if (latest.current.incoming?.channel === channel) {
      accept();
      return;
    }
    acceptWhenRung.current = channel;
    setTimeout(() => {
      if (acceptWhenRung.current === channel) acceptWhenRung.current = null;
    }, 30 * 1000);
  }

  // (Accepted, declined, answered elsewhere or over: the notification goes too, if it's still there. The
  // server also takes it away with a push, but that takes a moment.)
  function stopRinging() {
    clearInterval(ringTimer.current);
    ringTimer.current = null;
    Vibration.cancel();
    if (latest.current.incoming) clearCallNotification(latest.current.incoming.channel);
    setIncoming(null);
    latest.current.incoming = null;
  }

  function accept() {
    const call = latest.current.incoming;
    if (!call) return;
    stopRinging();
    connection.answerCall(call.channel, true);
    onOpenChatRef.current?.(call.channel);
    join(call.channel);
  }

  function decline() {
    const call = latest.current.incoming;
    if (!call) return;
    stopRinging();
    connection.answerCall(call.channel, false);
  }

  function showNotice(channel, text) {
    clearTimeout(noticeTimer.current);
    setNotice({ channel, text });
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }

  // The server's call messages (connection.js hands them over).
  connection.callListener.current = (data) => {
    const { incoming: ringingNow, outgoing: ours, roomName: inRoom } = latest.current;
    if (data.type === 'call') {
      // Already in that call (joined it from elsewhere): that's an answer.
      if (inRoom === data.channel) connection.answerCall(data.channel, true);
      else if (acceptWhenRung.current === data.channel) {  // Accepted in its notification already
        acceptWhenRung.current = null;
        latest.current.incoming = { channel: data.channel, from: data.from, name: data.name };
        accept();
      } else startRinging({ channel: data.channel, from: data.from, name: data.name });
    } else if (data.type === 'call_answered') {
      if (ringingNow?.channel === data.channel) stopRinging();  // (answered on another device)
      if (ours === data.channel) {
        setOutgoing(null);
        setStatus({ text: 'Voice connected', kind: 'ok' });
      }
    } else if (data.type === 'call_ended') {
      if (ringingNow?.channel === data.channel) stopRinging();
      if (ours === data.channel) {
        leave();
        showNotice(data.channel, data.reason === 'declined' ? 'Declined' : 'No answer');
      }
    }
  };

  // ----- What the screens draw

  // Everyone in our call as LiveKit sees them: {id, isMe, camera, screen}, camera and screen being
  // "track references" ({participant, publication, source}, what LiveKit's <VideoTrack> takes) or null.
  function callPeople() {
    const lk = room.current;
    if (!lk || lk.state !== 'connected') return [];
    const describe = (participant, isMe) => {
      const reference = (source) => {
        const publication = participant.getTrackPublication(source);
        return publication?.track && !publication.isMuted ? { participant, publication, source } : null;
      };
      return {
        id: Number(participant.identity), isMe,
        camera: reference(Track.Source.Camera), screen: reference(Track.Source.ScreenShare),
      };
    };
    return [describe(lk.localParticipant, true), ...[...lk.remoteParticipants.values()].map((p) => describe(p, false))];
  }

  const connected = room.current?.state === 'connected';

  return {
    settings, setSettings, personVolume, setPersonVolume, screenVolume, setScreenVolume, screenHasSound,
    roomName, status, muted, deafened, camera, facing, sharing, speaking, outputs, output, connected,
    outgoing, incoming, notice,
    join, leave, setNoiseSuppression, toggleMute, toggleDeafen, toggleCamera, flipCamera, toggleShare, refreshOutputs, selectOutput,
    startCall, accept, decline, acceptFromNotification, callPeople,
  };
}
