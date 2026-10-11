// Voice: the audio engine (Web Audio), the microphone and its gate, volumes, and who's
// in voice. See also video.js, rooms.js and voice-settings.js.
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ---------- Voice ----------
//
// Voice goes through our LiveKit server (voice.ps1), not through the chat's WebSocket. Joining:
// ask our server for a ticket (/voice-token), connect to LiveKit with it, then send the
// microphone. In LiveKit's words, everyone in a room is a "participant" who "publishes" their
// microphone as an audio "track", and "subscribes" to (receives) everyone else's.
//
// The sound goes through the browser's Web Audio engine, as a chain of "nodes" (like guitar
// pedals), all in one AudioContext:
//   microphone → noise suppression (RNNoise, when it's "On") → mic volume (a GainNode)
//     → noise gate (static/voice-gate.js) → a track LiveKit sends
//   each other person → their volume (a GainNode LiveKit makes for them) → speakers or headphones

const voiceBar = document.getElementById("voice-bar");
const voiceStatus = document.getElementById("voice-status");
const voiceWhere = document.getElementById("voice-where");
const voiceMuteButton = document.getElementById("voice-mute");
const voiceLeaveButton = document.getElementById("voice-leave");
const voiceAudio = document.getElementById("voice-audio");
const voiceInputSelect = document.getElementById("voice-input");
const voiceOutputSelect = document.getElementById("voice-output");
const voiceOutputRow = document.getElementById("voice-output-row");
const voiceDevicesHelp = document.getElementById("voice-devices-help");
const voiceMicVolumeSlider = document.getElementById("voice-mic-volume");
const voiceMicVolumeValue = document.getElementById("voice-mic-volume-value");
const voiceOutputVolumeSlider = document.getElementById("voice-output-volume");
const voiceOutputVolumeValue = document.getElementById("voice-output-volume-value");
const voiceMeterLevel = document.getElementById("voice-meter-level");
const voiceGateSlider = document.getElementById("voice-gate");
const voiceGateReadout = document.getElementById("voice-gate-readout");
const voiceTestButton = document.getElementById("voice-test");

let voiceRoom = null;       // the LiveKit Room we're in (or joining), or null
let voiceRoomName = null;   // its name: "lounge", or a DM's "dm:3:7"
let micMuted = false;       // stays the same between calls, like Discord
let cameraOn = false;       // always off when joining, like Discord
const voiceCameraButton = document.getElementById("voice-camera");
let micPublication = null;  // our microphone track as LiveKit sends it, while in a room
let micStream = null;       // the open microphone (from getUserMedia), or null
let micSource = null;       // ...as the first node of the chain
let micTesting = false;     // "Test microphone" in Settings is on

// ----- Settings, remembered in this browser: they belong to this device's microphone and speakers.
// Device ids "" mean the computer's default. Volumes in %, gate in decibels (-100 = always on).
// Noise suppression: "on" (RNNoise), "light" (the browser's own) or "off".
const voiceSettings = {
  inputDevice: "", outputDevice: "", cameraDevice: "", micVolume: 100, outputVolume: 100, gate: -60,
  noiseSuppression: "on",
  shareHeight: 1080, shareFps: 30,  // screen sharing quality: the last choice in the 🖥️ menu
};
try {
  Object.assign(voiceSettings, JSON.parse(localStorage.getItem("voiceSettings")) || {});
} catch {}

function saveVoiceSettings() {
  try {
    localStorage.setItem("voiceSettings", JSON.stringify(voiceSettings));
  } catch {}
}

// ----- The audio engine, made the first time it's needed (it needs a click on the page first).
// A Promise, because loading the gate takes a moment: everyone who needs it waits for the same one.
let voiceEngine = null;

function getAudio() {
  if (!voiceEngine) {
    voiceEngine = setUpAudio();
    voiceEngine.catch(() => { voiceEngine = null; });  // failed: try again next time
  }
  return voiceEngine;
}

async function setUpAudio() {
  // 48 000 samples a second, because RNNoise only works at that rate. (The browser converts a
  // microphone that uses another rate.)
  const context = new AudioContext({ sampleRate: 48000 });
  await context.audioWorklet.addModule("/voice-gate.js");  // load our gate into the audio engine
  const micGain = context.createGain();
  const gate = new AudioWorkletNode(context, "voice-gate");
  // The end of the chain: turns the sound back into a normal track, which LiveKit can send.
  const destination = context.createMediaStreamDestination();
  micGain.connect(gate).connect(destination);
  micGain.gain.value = voiceSettings.micVolume / 100;
  gate.port.postMessage({ threshold: voiceSettings.gate });
  gate.port.onmessage = (event) => showMicLevel(event.data);  // the gate's reports, ~30 a second
  const denoiser = await loadDenoiser(context);
  if (denoiser) denoiser.connect(micGain);
  const nodes = { context, micGain, gate, destination, denoiser };
  await applyOutputDevice(context);
  return nodes;
}

// RNNoise: a small neural network, trained to tell speech from everything else (keyboards, fans,
// dogs, ...). Every 10 ms it looks at the last 480 samples and turns down what isn't voice. It's
// written in C and compiled to WebAssembly (the .wasm file: code the browser runs almost as fast as
// a normal program), and runs in an AudioWorklet like our gate. Both come from npm's
// @sapphi-red/web-noise-suppressor; its worklet expects the .wasm file's bytes, so we fetch them
// here and hand them over. Returns the node, or null if it couldn't load ("On" then works like "Light").
async function loadDenoiser(context) {
  try {
    await context.audioWorklet.addModule("/rnnoise-0.4.1/rnnoise-worklet.js");
    const response = await fetch("/rnnoise-0.4.1/rnnoise_simd.wasm");
    if (!response.ok) throw new Error("RNNoise wasn't found");
    const wasmBinary = await response.arrayBuffer();
    // maxChannels 1: a microphone is one channel (mono).
    return new AudioWorkletNode(context, "@sapphi-red/web-noise-suppressor/rnnoise", {
      processorOptions: { wasmBinary, maxChannels: 1 },
    });
  } catch (error) {
    console.warn("Noise suppression (RNNoise) didn't load:", error);
    return null;
  }
}

// Send the others' voices to the chosen speakers or headphones (where the browser can).
async function applyOutputDevice(context) {
  if (!("setSinkId" in context)) return;
  try {
    await context.setSinkId(voiceSettings.outputDevice);
  } catch {
    await context.setSinkId("").catch(() => {});  // unplugged since: the default instead
  }
}

// ----- The microphone

async function openMic() {
  const { context, micGain, denoiser } = await getAudio();
  await context.resume();  // an AudioContext starts paused until the page has been clicked
  // "On" uses RNNoise (if it loaded), and then not the browser's own suppression as well: two
  // filters in a row can make voices sound watery. "Light" is the browser's own only.
  const useRnnoise = voiceSettings.noiseSuppression === "on" && denoiser !== null;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // "ideal": this one if it's there, otherwise the default (if it was unplugged).
      deviceId: voiceSettings.inputDevice ? { ideal: voiceSettings.inputDevice } : undefined,
      // The browser's own clean-up: no echo of the others from your speakers, an even volume,
      // and (unless it's off or RNNoise does it) less steady background noise like fans and hum.
      echoCancellation: true,
      noiseSuppression: voiceSettings.noiseSuppression !== "off" && !useRnnoise,
      autoGainControl: true,
    },
  });
  closeMic();  // another microphone was open (switching devices): close that one first
  micStream = stream;
  micSource = context.createMediaStreamSource(stream);
  micSource.connect(useRnnoise ? denoiser : micGain);
  listDevices();  // now that we may use the microphone, the browser tells us the devices' names
}

function closeMic() {
  if (micSource) micSource.disconnect();
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();  // the "mic in use" light goes out
  }
  micSource = null;
  micStream = null;
  showMicLevel({ level: -100, open: false });
  showGateReadout();  // without "Your mic" now (even if the last update was just now)
}

// Close the microphone if nothing needs it any more (not in voice, not testing it).
function closeMicIfUnused() {
  if (!micTesting && !micPublication) closeMic();
}

// The level meter in Settings: how loud the microphone is, green while the gate lets it through.
let micLevel = -100;      // the latest level from the gate, in dB
let readoutShownAt = 0;   // when the numbers were last updated (performance.now(), in ms)

function showMicLevel({ level, open }) {
  voiceMeterLevel.style.width = (level + 100) + "%";  // -100 dB = empty, 0 dB = full
  voiceMeterLevel.classList.toggle("open", open);
  micLevel = level;
  // The bar moves ~30 times a second, but numbers changing that fast can't be read: 4 is enough.
  if (performance.now() - readoutShownAt > 250) showGateReadout();
}

// "Line −52 dB · Your mic −64 dB". (The real minus sign "−" instead of "-" reads better.)
function showGateReadout() {
  readoutShownAt = performance.now();
  const decibels = (value) => String(Math.round(value)).replace("-", "−") + " dB";
  const line = voiceSettings.gate <= -100 ? "Line off (always on)" : "Line " + decibels(voiceSettings.gate);
  voiceGateReadout.textContent = micStream ? `${line} · Your mic ${decibels(micLevel)}` : line;
}

// Send our microphone in this room (turning it on if needed). Throws if the browser won't let us.
async function sendMic(room) {
  if (!micStream) await openMic();
  const engine = await getAudio();
  if (voiceRoom !== room) return;  // left while waiting
  // The track at the end of our chain. A stopped track can never start again, and LiveKit stops
  // the tracks it sends when a room disconnects by itself (a dropped connection, a server
  // restart). Then: a fresh end for the chain, with a new, working track.
  if (engine.destination.stream.getAudioTracks()[0].readyState === "ended") {
    engine.gate.disconnect(engine.destination);
    engine.destination = engine.context.createMediaStreamDestination();
    engine.gate.connect(engine.destination);
  }
  if (!micPublication) {
    micPublication = await room.localParticipant.publishTrack(engine.destination.stream.getAudioTracks()[0], {
      source: LivekitClient.Track.Source.Microphone,
    });
  } else if (micPublication.isMuted) {
    await micPublication.unmute();
  }
}

function showNoMicrophone() {
  micMuted = true;
  showMuteButton();
  setVoiceStatus("Connected, no microphone", "error");
  voiceStatus.title = "The browser didn't allow the microphone. Allow it (the icon in the address bar) and unmute.";
}

// ----- Volumes

// Each person's own volume for us, in %, by user id: {"7": 150}. Also remembered in this browser.
// Only the ones that aren't 100% are kept.
let personVolumes = {};
try {
  personVolumes = JSON.parse(localStorage.getItem("voicePersonVolumes")) || {};
} catch {}

function personVolume(userId) {
  return personVolumes[userId] ?? 100;  // ?? : the value on the right if the left is missing
}

function setPersonVolume(userId, percent) {
  if (percent === 100) {
    delete personVolumes[userId];
  } else {
    personVolumes[userId] = percent;
  }
  try {
    localStorage.setItem("voicePersonVolumes", JSON.stringify(personVolumes));
  } catch {}
  // In a call with them: louder or quieter straight away. LiveKit knows people by their
  // "identity", which our server set to their user id (the token's "sub").
  const participant = voiceRoom && voiceRoom.remoteParticipants.get(String(userId));
  if (participant) applyVolume(participant);
}

// How loud one person is for us: everyone's volume (Settings) times their own (profile popup).
// 150% × 120% = 180%: LiveKit's GainNode for them simply multiplies the sound by 1.8.
function applyVolume(participant) {
  const volume = (voiceSettings.outputVolume / 100) * (personVolume(participant.identity) / 100);
  participant.setVolume(volume);  // their voice
  // ...and the sound of their shared screen (LiveKit keeps a volume per source).
  participant.setVolume(volume, LivekitClient.Track.Source.ScreenShareAudio);
}

// ----- Who's in voice (in the sidebar, for everyone) and who's talking (only while you're in there)

let voiceMembers = {};        // from the server: {"lounge": [{id: 3, muted: false}, ...]}
let speakingIds = new Set();  // identities (user ids as text) talking right now, from LiveKit

// Tell our server where we are in voice and whether we're muted, so everyone's sidebar shows it.
// Only once really connected: "Connecting…" doesn't count.
function sendVoiceState() {
  const connected = voiceRoom && voiceRoom.state === "connected";
  sendToServer({ type: "voice", room: connected ? voiceRoomName : null, muted: micMuted });
}

function renderVoiceMembers() {
  for (const box of document.querySelectorAll(".voice-members")) {
    const rows = (voiceMembers[box.dataset.room] || []).map(({ id, muted }) => {
      const name = people.has(id) ? people.get(id).name : "?";
      const row = document.createElement("button");
      row.type = "button";
      row.className = "voice-member";
      row.dataset.userId = id;
      const label = document.createElement("span");
      label.className = "voice-member-name";
      label.textContent = name;
      row.append(makeAvatar(id, name, "small"), label);
      if (muted) {
        const icon = document.createElement("span");
        icon.textContent = "🔇";
        icon.title = "Muted";
        row.append(icon);
      }
      // Click (or right-click, instead of the browser's own menu): their profile, with the volume.
      row.addEventListener("click", () => openProfile(id));
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openProfile(id);
      });
      return row;
    });
    box.replaceChildren(...rows);
  }
  showSpeaking();
  renderLoungeView();  // its tiles follow the same list
}

// Light up the ring of whoever is talking. Only switches a class on and off, instead of
// redrawing the list: LiveKit sends these changes several times a second.
function showSpeaking() {
  for (const row of document.querySelectorAll(".voice-member")) {
    const room = row.closest(".voice-members").dataset.room;
    row.classList.toggle("speaking", room === voiceRoomName && speakingIds.has(row.dataset.userId));
  }
  // ...and in the call banner, which shows the DM we're looking at.
  for (const tile of document.querySelectorAll("#call-tiles .call-tile")) {
    tile.classList.toggle("speaking", currentChannel === voiceRoomName && speakingIds.has(tile.dataset.userId));
  }
  // ...and on the Lounge page (only while we're in Lounge: that's when LiveKit tells us).
  for (const tile of document.querySelectorAll("#lounge-tiles .call-tile")) {
    tile.classList.toggle("speaking", voiceRoomName === "lounge" && speakingIds.has(tile.dataset.userId));
  }
}
