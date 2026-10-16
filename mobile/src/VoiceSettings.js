// Settings → Voice & audio and Video (the web page's voice-settings.js), kept on the phone (voice.js's
// settings). Noise suppression, the mic volume and the sensitivity line (the noise gate) are the web page's,
// done in our own native code instead of Web Audio (MicProcessor.kt, with RNNoise compiled in). Where a phone
// differs: no microphone or speaker lists (a call's own button picks the speaker, the earpiece, headphones or
// Bluetooth); no push to talk; the camera is the front or the back one.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { RTCView, mediaDevices } from '@livekit/react-native-webrtc';
import { Button, Heading, Help, Title } from './SettingsParts';
import Slider from './Slider';
import { CAMERA_CAPTURE } from './voice';
import { useStyles } from './theme';

// A row of choices, one of them picked (like a <select>, but every choice in sight). It wraps onto
// more lines when they don't fit (Settings → Notifications' mute uses it too).
export function Choices({ choices, value, onPick }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.choices}>
      {choices.map(([key, label]) => (
        <Pressable
          key={key} onPress={() => onPick(key)}
          style={({ pressed }) => [styles.choice, value === key && styles.chosen, pressed && styles.pressed]}
        >
          <Text style={[styles.choiceText, value === key && styles.chosenText]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// "−52 dB", with a real minus sign (it reads better than "-"), like the web page's readout.
const decibels = (value) => String(Math.round(value)).replace('-', '−') + ' dB';

// The sensitivity line and the microphone's meter (the web page's #voice-meter with #voice-gate on it): the
// bar is how loud the microphone is, green while it gets through; the line is the noise gate's (all the way
// left: always on). Outside a call, "Test microphone": expo-audio's recorder measures it ("metering", in dB:
// -160 is silence, 0 the loudest; what it records is thrown away), and the mic volume is added here (+6 dB is
// twice as loud), as it doesn't go through MicProcessor. In a call the bar is the call's own microphone,
// as the others get it (MicProcessor.kt's level and gate, asked 20 times a second).
function MicTest({ voice, micVolume }) {
  const styles = useStyles(makeStyles);
  const inCall = voice.roomName !== null;
  const [gate, setGate] = useState(voice.settings.gate);
  const [live, setLive] = useState({ level: -100, open: false });  // in a call: the newest from MicProcessor
  useEffect(() => {
    if (!inCall) return undefined;
    const timer = setInterval(() => setLive(voice.muted ? { level: -100, open: false } : voice.micLevel()), 50);
    return () => clearInterval(timer);
  }, [inCall, voice.muted]);
  const recorder = useAudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 50);  // (asked 20 times a second)
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState('');

  async function start() {
    setProblem('');
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setProblem("ChatApp isn't allowed to use the microphone: allow it in Android's settings for the app.");
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setTesting(true);
    } catch {
      setProblem("Couldn't open the microphone.");
    }
  }

  async function stop() {
    setTesting(false);
    try {
      await recorder.stop();
    } catch {}
  }

  // Leaving the page (or joining a call) stops it.
  useEffect(() => {
    if (inCall && testing) stop();
  }, [inCall]);
  useEffect(() => () => {
    recorder.stop().catch(() => {});
  }, []);

  // -100 dB at the left end, 0 at the right (the web page's meter).
  const boost = micVolume > 0 ? 20 * Math.log10(micVolume / 100) : -100;
  const level = inCall ? live.level : testing && typeof state.metering === 'number' ? state.metering + boost : -100;
  const open = inCall ? live.open : testing && (gate <= -100 || level > gate);
  const at = (db) => `${Math.min(100, Math.max(0, db + 100))}%`;
  // "Line −52 dB · Your mic −64 dB": the numbers at most 4 times a second (faster can't be read).
  const shown = useRef({ at: 0, level: -100 });  // (a ref: changing it redraws nothing)
  if (Date.now() - shown.current.at > 250) shown.current = { at: Date.now(), level };
  const line = gate <= -100 ? 'Line off (always on)' : `Line ${decibels(gate)}`;
  return (
    <>
      <Text style={styles.meterTitle}>Sensitivity: when the bar is left of the line, your microphone is silent</Text>
      <View style={styles.meter}>
        <View style={[styles.meterLevel, open && styles.meterOpen, { width: at(level) }]} />
        {gate > -100 ? <View style={[styles.gateLine, { left: at(gate) }]} /> : null}
      </View>
      <Slider
        value={gate} min={-100} max={0} step={1}
        onChange={(value) => {
          setGate(value);
          voice.setSettings({ gate: value });  // (MicProcessor gets it at once, also mid-call)
        }}
      />
      <Text style={styles.readout}>{inCall || testing ? `${line} · Your mic ${decibels(shown.current.level)}` : line}</Text>
      <Help>
        Stay quiet and drag the line a little right of where the bar sits, then talk: the bar turns green when
        your voice gets through. All the way left: always on.
      </Help>
      {inCall ? (
        <Help>You're in a call: the bar shows your microphone in it.</Help>
      ) : (
        <View style={styles.buttonRow}>
          <Button label={testing ? 'Stop test' : 'Test microphone'} onPress={testing ? stop : start} />
        </View>
      )}
      {problem ? <Text style={styles.error}>{problem}</Text> : null}
    </>
  );
}

export function VoiceSettings({ voice }) {
  const styles = useStyles(makeStyles);
  const [volume, setVolume] = useState(voice.settings.outputVolume);
  const [micVolume, setMicVolume] = useState(voice.settings.micVolume);
  return (
    <View>
      <Title>Voice & audio</Title>
      <Heading>Noise suppression</Heading>
      <Choices
        choices={[['on', 'On'], ['light', 'Light'], ['off', 'Off']]} value={voice.settings.noiseSuppression}
        onPick={voice.setNoiseSuppression}
      />
      <Help>
        On: AI, also keyboards, dogs and voices in the background. Light: the phone's own, for fans and hum.
        Echo cancelling is always on.
      </Help>

      <Heading>Mic volume</Heading>
      <View style={styles.sliderRow}>
        <View style={styles.slider}>
          <Slider
            value={micVolume} min={0} max={200} step={5}
            onChange={(value) => {
              setMicVolume(value);
              voice.setSettings({ micVolume: value });
            }}
          />
        </View>
        <Text style={styles.sliderValue}>{micVolume}%</Text>
      </View>

      <Heading>Others' volume</Heading>
      <View style={styles.sliderRow}>
        <View style={styles.slider}>
          <Slider
            value={volume} min={0} max={200} step={5}
            onChange={(value) => {
              setVolume(value);
              voice.setSettings({ outputVolume: value });
            }}
          />
        </View>
        <Text style={styles.sliderValue}>{volume}%</Text>
      </View>
      <Help>
        Everyone in calls. Each person's own volume is on their profile. Where the sound goes (speaker,
        earpiece, headphones, Bluetooth) is a button in the call.
      </Help>

      <Heading>Microphone</Heading>
      <MicTest voice={voice} micVolume={micVolume} />
    </View>
  );
}

// "Test camera": what the camera sees (mirrored, like a mirror, if it's the front one). react-native-webrtc's
// own camera and view (a browser's getUserMedia and <video>, in React Native).
export function VideoSettings({ voice }) {
  const styles = useStyles(makeStyles);
  const [stream, setStream] = useState(null);
  const [problem, setProblem] = useState('');
  const streamRef = useRef(null);
  const facing = voice.settings.camera;
  const inCall = voice.roomName !== null;

  function stopPreview() {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();  // the camera goes off
    streamRef.current = null;
    setStream(null);
  }

  async function startPreview(which = facing) {
    stopPreview();
    setProblem('');
    try {
      // The same size as in calls (4:3, the sensor's shape), so the preview shows what the others will see.
      const { width, height } = CAMERA_CAPTURE.resolution;
      const next = await mediaDevices.getUserMedia({ video: { facingMode: which, width, height } });
      streamRef.current = next;
      setStream(next);
    } catch {
      setProblem("Couldn't open the camera. Is ChatApp allowed to use it (Android's settings for the app)?");
    }
  }

  useEffect(() => stopPreview, []);
  useEffect(() => {
    if (inCall) stopPreview();
  }, [inCall]);

  function pick(which) {
    voice.setSettings({ camera: which });
    if (streamRef.current) startPreview(which);  // (the preview follows)
  }

  return (
    <View>
      <Title>Video</Title>
      <Heading>Camera</Heading>
      <Choices choices={[['user', 'Front'], ['environment', 'Back']]} value={facing} onPick={pick} />
      <Help>The one that turns on in calls. In a call you can switch with the camera button.</Help>
      {stream ? (
        // contain: all of the picture, nothing cut off (cover filled the box by cutting).
        <RTCView streamURL={stream.toURL()} style={styles.preview} objectFit="contain" mirror={facing === 'user'} />
      ) : null}
      {inCall ? <Help>You're in a call: leave it to test the camera.</Help> : null}
      <View style={styles.buttonRow}>
        <Button
          label={stream ? 'Stop camera test' : 'Test camera'} disabled={inCall}
          onPress={stream ? stopPreview : () => startPreview()}
        />
      </View>
      {problem ? <Text style={styles.error}>{problem}</Text> : null}
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  choice: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6, backgroundColor: colors.bgDarkest },
  chosen: { backgroundColor: colors.accent },
  pressed: { opacity: 0.8 },
  choiceText: { color: colors.text, fontSize: size(15.2) },
  chosenText: { color: '#ffffff' },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  slider: { flex: 1 },
  sliderValue: { width: 48, textAlign: 'right', color: colors.textMuted, fontSize: size(14.4) },
  // #voice-meter: a dark bar with the level growing from the left, green while it counts as talking.
  meter: { height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.bgDarkest, marginBottom: 8 },
  meterLevel: { height: '100%', backgroundColor: colors.textMuted },
  meterOpen: { backgroundColor: colors.green },
  meterTitle: { color: colors.textSoft, fontSize: size(13.6), marginBottom: 6 },
  // The sensitivity line on the meter (the web page's slider thumb sits there): a white bar across it.
  gateLine: { position: 'absolute', top: 0, bottom: 0, width: 3, marginLeft: -1, backgroundColor: colors.textStrong },
  readout: { color: colors.textMuted, fontSize: size(13.6), marginTop: 4 },
  buttonRow: { flexDirection: 'row', marginTop: 8 },
  // The camera's picture, rounded: 3:4, the shape of a 4:3 camera with the phone held upright, in the middle.
  preview: {
    width: '70%', aspectRatio: 3 / 4, alignSelf: 'center', borderRadius: 8, overflow: 'hidden', marginTop: 8,
    backgroundColor: '#000000',
  },
  error: { marginTop: 8, color: colors.red, fontSize: size(13.6) },
});
