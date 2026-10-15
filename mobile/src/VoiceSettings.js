// Settings → Voice & audio and Video (the web page's voice-settings.js), kept on the phone (voice.js's
// settings). Noise suppression and the mic volume are the web page's, done in our own native code instead of
// Web Audio (MicProcessor.kt, with RNNoise compiled in). Where a phone differs: no microphone or speaker lists
// (a call's own button picks the speaker, the earpiece, headphones or Bluetooth); no sensitivity line or push
// to talk (Web Audio's); the camera is the front or the back one.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { RTCView, mediaDevices } from '@livekit/react-native-webrtc';
import { Button, Heading, Help, Title } from './SettingsParts';
import Slider from './Slider';
import { useStyles } from './theme';

// A row of choices, one of them picked (like a <select>, but every choice in sight).
function Choices({ choices, value, onPick }) {
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

// "Test microphone": how loud the microphone is, as a bar (the web page's #voice-meter), green while it's
// loud enough to count as talking. expo-audio's recorder measures it ("metering", in dB: -160 is silence,
// 0 the loudest); what it records is thrown away. Not during a call, which has the microphone already.
// micVolume: the bar shows the sound as the others would get it, the mic volume included (it doesn't go
// through MicProcessor, so the volume is added here: +6 dB is twice as loud).
function MicTest({ inCall, micVolume }) {
  const styles = useStyles(makeStyles);
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

  // -100 dB at the left end, 0 at the right (the web page's meter); talking from -50 dB (SPEAKING_LINE).
  const boost = micVolume > 0 ? 20 * Math.log10(micVolume / 100) : -100;
  const level = testing && typeof state.metering === 'number' ? state.metering + boost : -100;
  const fraction = Math.min(1, Math.max(0, (level + 100) / 100));
  return (
    <>
      <View style={styles.meter}>
        <View style={[styles.meterLevel, level > -50 && styles.meterOpen, { width: `${fraction * 100}%` }]} />
      </View>
      {inCall ? <Help>You're in a call: your microphone is busy there. Leave it to test.</Help> : null}
      <View style={styles.buttonRow}>
        <Button label={testing ? 'Stop test' : 'Test microphone'} disabled={inCall} onPress={testing ? stop : start} />
      </View>
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
      <MicTest inCall={voice.roomName !== null} micVolume={micVolume} />
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
      const next = await mediaDevices.getUserMedia({ video: { facingMode: which } });
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
        <RTCView streamURL={stream.toURL()} style={styles.preview} objectFit="cover" mirror={facing === 'user'} />
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
  choices: { flexDirection: 'row', gap: 8, marginBottom: 8 },
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
  buttonRow: { flexDirection: 'row', marginTop: 8 },
  // #camera-preview: the camera's picture, 16:9, rounded.
  preview: { width: '100%', aspectRatio: 16 / 9, borderRadius: 8, overflow: 'hidden', marginTop: 8, backgroundColor: '#000000' },
  error: { marginTop: 8, color: colors.red, fontSize: size(13.6) },
});
