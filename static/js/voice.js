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
let deafened = false;       // hearing nobody (and muted too), like Discord's 🎧 button
let mutedBeforeDeafen = false;  // what the mute was before deafening: back to that afterwards
let cameraOn = false;       // always off when joining, like Discord
const voiceCameraButton = document.getElementById("voice-camera");
let micPublication = null;  // our microphone track as LiveKit sends it, while in a room
let micStream = null;       // the open microphone (from getUserMedia), or null
let micSource = null;       // ...as the first node of the chain
let micTesting = false;     // "Test microphone" in Settings is on

// ----- Settings, remembered in this browser: they belong to this device's microphone and speakers.
// Device ids "" mean the computer's default. Volumes in %, gate in decibels (-100 = always on).
// Noise suppression: "on" (RNNoise), "light" (the browser's own) or "off".
// Input mode: "voice" (the gate's line decides) or "ptt" (push to talk: a key decides, see below).
const voiceSettings = {
  inputDevice: "", outputDevice: "", cameraDevice: "", micVolume: 100, outputVolume: 100, gate: -60,
  noiseSuppression: "on",
  inputMode: "voice", pttKey: "", pttWindowsKey: 0, pttName: "",  // (the key: see "Push to talk")
  shareHeight: 1080, shareFps: 30,  // screen sharing quality: the last choice in the 🖥️ menu
  miniCorner: "bottom-right",  // where the others float in fullscreen (rooms.js, the mini window)
  miniHidden: false,           // ...or hidden with 👥
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
  // Load our gate into the audio engine. "?v=": the page's version (core.js, from "welcome"), so every
  // version has its own address: Cloudflare keeps .js files by their address, and once handed out an
  // old gate for hours after a deploy (2026-10-14).
  await context.audioWorklet.addModule("/voice-gate.js?v=" + (pageVersion ?? ""));
  const micGain = context.createGain();
  const gate = new AudioWorkletNode(context, "voice-gate");
  // The end of the chain: turns the sound back into a normal track, which LiveKit can send.
  const destination = context.createMediaStreamDestination();
  micGain.connect(gate).connect(destination);
  micGain.gain.value = voiceSettings.micVolume / 100;
  gate.port.postMessage({ threshold: voiceSettings.gate, ptt: voiceSettings.inputMode === "ptt", talking: false });
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
    // One channel (mono) in and out. Windows often gives the browser a microphone as two channels
    // (stereo), even a mono one: "explicit" makes the browser mix those into one before RNNoise.
    // Otherwise RNNoise only cleans the first (left) one, the right stays silent, and the others
    // hear us in one ear. After it, the chain spreads the one channel over both ears again.
    return new AudioWorkletNode(context, "@sapphi-red/web-noise-suppressor/rnnoise", {
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
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
  // Nothing needs the audio engine now (no test, no call): pause it. Running, RNNoise and the gate
  // would go on working on silence, about 100 times a second, which warms a phone and slows the
  // page. Paused, it costs nothing; openMic and joining a call wake it again (resume).
  if (!micTesting && !voiceRoom && voiceEngine) {
    voiceEngine.then(({ context }) => context.suspend()).catch(() => {});
  }
}

// The level meter in Settings: how loud the microphone is, green while the gate lets it through.
let micLevel = -100;      // the latest level from the gate, in dB
let gateOpen = false;     // ...and whether it lets the microphone through right now
let readoutShownAt = 0;   // when the numbers were last updated (performance.now(), in ms)

function showMicLevel({ level, open }) {
  gateOpen = open;  // (our own speaking ring, see "Who's talking")
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
  let line = voiceSettings.gate <= -100 ? "Line off (always on)" : "Line " + decibels(voiceSettings.gate);
  if (voiceSettings.inputMode === "ptt") line = "Push to talk";
  voiceGateReadout.textContent = micStream ? `${line} · Your mic ${decibels(micLevel)}` : line;
}

// ----- Push to talk (Settings → Voice & audio → Input mode)
//
// The key is kept three ways (set in voice-settings.js):
// - pttKey: the KeyboardEvent's "code", the physical key ("KeyV", "Space", "ShiftLeft"); a mouse button
//   as "Mouse1" (middle), "Mouse3" (back) or "Mouse4" (forward), after MouseEvent's button numbers
// - pttWindowsKey: Windows' own number for it (its "virtual-key code"), for the Windows app
// - pttName: what Settings shows ("V", "Shift Left", "Mouse back button")
let pttHeldHere = false;  // held, by this window's own key events (only while it has focus)
let pttHeldApp = false;   // held, says the Windows app, which also sees keys pressed in other programs
let pttWaiting = false;   // Settings is waiting for the new key (voice-settings.js): don't talk then

// Tell the gate whether to let the microphone through. While this window has focus, its own key
// events decide (they know when you're typing in a text box); otherwise the app's.
function updatePushToTalk() {
  const ptt = voiceSettings.inputMode === "ptt";
  const talking = ptt && (document.hasFocus() ? pttHeldHere : pttHeldApp);
  // (No audio engine yet: nothing to tell. setUpAudio tells a new gate the mode itself.)
  // (The threshold too: a gate from before push to talk, still in a browser's cache, only reads that.)
  const message = { threshold: voiceSettings.gate, ptt, talking };
  if (voiceEngine) voiceEngine.then(({ gate }) => gate.port.postMessage(message)).catch(() => {});
}

// A letter (or space) key pressed while typing in a text box: that's typing, not talking.
function isTyping(event) {
  return event.key.length === 1 && event.target.closest?.("input, textarea, [contenteditable]");
}

document.addEventListener("keydown", (event) => {
  if (voiceSettings.inputMode !== "ptt" || pttWaiting || event.code !== voiceSettings.pttKey) return;
  if (event.repeat || isTyping(event)) return;  // (repeat: a held key sends keydown again and again)
  pttHeldHere = true;
  updatePushToTalk();
});

document.addEventListener("keyup", (event) => {
  if (voiceSettings.inputMode !== "ptt" || event.code !== voiceSettings.pttKey) return;
  pttHeldHere = false;
  updatePushToTalk();
});

// Mouse buttons. preventDefault: the back and forward buttons would otherwise go back a page.
for (const [type, held] of [["mousedown", true], ["mouseup", false], ["auxclick", null]]) {
  document.addEventListener(type, (event) => {
    if (voiceSettings.inputMode !== "ptt" || "Mouse" + event.button !== voiceSettings.pttKey) return;
    event.preventDefault();
    if (held === null || pttWaiting) return;  // (auxclick: only stopping the browser)
    pttHeldHere = held;
    updatePushToTalk();
  });
}

// Leaving the window while holding the key: its "up" goes to another program, so let go here.
window.addEventListener("blur", () => {
  pttHeldHere = false;
  updatePushToTalk();
});
window.addEventListener("focus", updatePushToTalk);

// The Windows app (0.1.19 and newer, main.rs) watches the key in every program and calls this
// (window.eval) each time it goes down or up.
function pushToTalkFromApp(held) {
  pttHeldApp = held;
  updatePushToTalk();
}

// Tell the app which key to watch, as Windows' number for it (0: none, stop watching).
function tellAppPushToTalkKey() {
  if (!inDesktopApp) return;
  const key = voiceSettings.inputMode === "ptt" ? voiceSettings.pttWindowsKey : 0;
  pttHeldApp = false;
  window.__TAURI_INTERNALS__.invoke("set_push_to_talk", { key }).catch(() => {});  // (an older app: not there)
}
tellAppPushToTalkKey();

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

// Where to allow the microphone or camera: the browser's site settings, and on a phone also the
// phone's own permissions for the browser or the installed app (Android blocked Chrome itself
// once: then Chrome can't even ask). Used here and by the tests in Settings (voice-settings.js).
const ALLOW_HOW = "Allow it in the site's settings (the icon left of the address), and check that " +
  "your phone allows it for the browser or the app (Android: Settings, Apps, Chrome or ChatApp, Permissions).";

// What went wrong when the microphone or camera didn't start. Browser errors have a name that
// says what kind they are: NotAllowedError means refused (by you, the browser or the phone),
// NotReadableError that another program is using it. Anything else: the browser's own words.
function describeMediaError(error, what) {
  if (error.name === "NotAllowedError") return `The ${what} isn't allowed. ${ALLOW_HOW}`;
  if (error.name === "NotReadableError") return `Another program is using the ${what}. Close it and try again.`;
  return `The ${what} couldn't start: ${error.name} (${error.message})`;
}

function showNoMicrophone(error) {
  micMuted = true;
  showMuteButton();
  setVoiceStatus("Connected, no microphone", "error");
  voiceStatus.title = (error ? describeMediaError(error, "microphone") : "") + " Then unmute.";
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

// The sound of each person's shared screen, in %, kept the same way but on its own: a video can
// be turned down without turning them down too. (Set with the slider on the screen, rooms.js.)
let screenVolumes = {};
try {
  screenVolumes = JSON.parse(localStorage.getItem("voiceScreenVolumes")) || {};
} catch {}

function screenVolume(userId) {
  return screenVolumes[userId] ?? 100;
}

function setScreenVolume(userId, percent) {
  if (percent === 100) {
    delete screenVolumes[userId];
  } else {
    screenVolumes[userId] = percent;
  }
  try {
    localStorage.setItem("voiceScreenVolumes", JSON.stringify(screenVolumes));
  } catch {}
  const participant = voiceRoom && voiceRoom.remoteParticipants.get(String(userId));
  if (participant) applyVolume(participant);
}

// How loud one person is for us: everyone's volume (Settings) times their own (profile popup).
// 150% × 120% = 180%: LiveKit's GainNode for them simply multiplies the sound by 1.8.
// Their shared screen's sound: everyone's volume times the screen's own. LiveKit keeps a
// volume per source. Deafened: times 0. (Their own volumes stay as they were, for when we undeafen.)
function applyVolume(participant) {
  const everyone = deafened ? 0 : voiceSettings.outputVolume / 100;
  participant.setVolume(everyone * (personVolume(participant.identity) / 100));  // their voice
  participant.setVolume(everyone * (screenVolume(participant.identity) / 100), LivekitClient.Track.Source.ScreenShareAudio);
}

// ----- Who's in voice (in the sidebar, for everyone) and who's talking (only while you're in there)

let voiceMembers = {};        // from the server: {"lounge": [{id: 3, muted: false}, ...]}
let speakingIds = new Set();  // identities (user ids as text) talking right now (see just below)

// Who's talking, measured here instead of by the LiveKit server (which only counted fairly loud
// voices and told us every half second). Each other person's voice passes through an AnalyserNode
// on its way to their volume (rooms.js plugs it in): it lets the sound through unchanged and lets us
// look at the latest samples. 20 times a second we work out how loud each one is (the same RMS in
// decibels as our gate) and compare it with a low line, so whispers count. Our own ring follows our
// gate: lit exactly while our microphone gets through (also with push to talk).
const SPEAKING_LINE = -55;        // dB: quieter than this is silence (a whisper is around -45)
const SPEAKING_HOLD_MS = 300;     // stay lit this long after the last sound: no flicker between words
const voiceAnalysers = new Map(); // identity -> the AnalyserNode on their voice
const lastHeard = new Map();      // identity -> when they were last louder than the line (performance.now())
let speakingTimer = null;

// rooms.js, when someone's microphone reaches us: an AnalyserNode for it, plugged in before their volume.
function listenForSpeaking(identity, track, context) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;  // looks at the last 2048 samples: 43 ms, about what passes between two looks
  track.setWebAudioPlugins([analyser]);  // LiveKit: their sound → our nodes → their volume → speakers
  voiceAnalysers.set(identity, analyser);
  watchSpeaking();
}

// Start looking (rooms.js, on joining: our own ring needs it before anyone else is there too).
function watchSpeaking() {
  if (!speakingTimer) speakingTimer = setInterval(checkSpeaking, 50);
}

function stopListeningForSpeaking(identity) {
  voiceAnalysers.delete(identity);
  lastHeard.delete(identity);
}

const speakingSamples = new Float32Array(2048);

function checkSpeaking() {
  if (!voiceRoom) {  // left the call (leaveVoice has cleared the rest): stop looking
    clearInterval(speakingTimer);
    speakingTimer = null;
    return;
  }
  const now = performance.now();
  const talking = new Set();
  for (const [identity, analyser] of voiceAnalysers) {
    analyser.getFloatTimeDomainData(speakingSamples);  // copies the latest samples into our array
    let sum = 0;
    for (const sample of speakingSamples) sum += sample * sample;
    const level = 10 * Math.log10(sum / speakingSamples.length + 1e-10);
    if (level > SPEAKING_LINE) lastHeard.set(identity, now);
    if (now - (lastHeard.get(identity) ?? -Infinity) < SPEAKING_HOLD_MS) talking.add(identity);
  }
  if (micPublication && !micMuted && gateOpen) talking.add(String(myId));
  // Only redraw when someone started or stopped (most of the time nothing changed).
  const changed = talking.size !== speakingIds.size || [...talking].some((id) => !speakingIds.has(id));
  if (changed) {
    speakingIds = talking;
    showSpeaking();
  }
}

// Tell our server where we are in voice and whether we're muted or deafened, so everyone's
// sidebar shows it. Only once really connected: "Connecting…" doesn't count.
function sendVoiceState() {
  const connected = voiceRoom && voiceRoom.state === "connected";
  sendToServer({ type: "voice", room: connected ? voiceRoomName : null, muted: micMuted, deafened });
}

// Next to someone in voice: 🔇 when muted, a crossed-out 🎧 when deafened (they can't hear you
// either), or nothing (null).
function makeVoiceStateIcon({ muted, deafened }) {
  if (!muted && !deafened) return null;
  const icon = document.createElement("span");
  icon.className = deafened ? "voice-state deafened" : "voice-state";
  icon.textContent = deafened ? "🎧" : "🔇";
  icon.title = deafened ? "Deafened" : "Muted";
  return icon;
}

function renderVoiceMembers() {
  for (const box of document.querySelectorAll(".voice-members")) {
    const rows = (voiceMembers[box.dataset.room] || []).map(({ id, muted, deafened }) => {
      const name = people.has(id) ? people.get(id).name : "?";
      const row = document.createElement("button");
      row.type = "button";
      row.className = "voice-member";
      row.dataset.userId = id;
      const label = document.createElement("span");
      label.className = "voice-member-name";
      label.textContent = name;
      row.append(makeAvatar(id, name, "small"), label);
      const icon = makeVoiceStateIcon({ muted, deafened });
      if (icon) row.append(icon);
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

// ----- Connection quality: the signal icon in the voice bar, and its popup (like Discord's)
//
// WebRTC keeps statistics on every connection, and LiveKit lets us read them per track
// (getRTCStatsReport: the browser's getStats() for that track, a Map of "stats" objects, each
// with a "type"). Every 5 seconds while in voice we read:
//   - ping: the route the audio takes to our LiveKit server ("candidate-pair") knows how long a
//     packet takes there and back (currentRoundTripTime, in seconds)
//   - UDP or TCP: that route's own end ("local-candidate"); TCP is LiveKit's fallback
//   - outbound packet loss: what we sent ("outbound-rtp") against what the server says never
//     arrived ("remote-inbound-rtp": its regular reports back to us)
//   - inbound packet loss: of the others' voices, what never reached us ("inbound-rtp")
// The counters only ever go up, so the loss is worked out from the difference with 5 seconds
// ago: what's happening now, not an average since joining.

const voiceSignal = document.getElementById("voice-signal");
const voiceStatsDialog = document.getElementById("voice-stats");
const pingGraph = document.getElementById("ping-graph");
const STATS_SECONDS = 5;    // how often we measure
const GRAPH_SECONDS = 300;  // how far back the graph goes: 5 minutes

let statsTimer = null;
let pingSamples = [];   // [{time, ping}]: when (ms since 1970) and the ping (ms), the last 5 minutes
let connection = null;  // the latest: {ping, protocol, outLoss, inLoss} (null where unknown)
let lastCounts = null;  // the packet counters last time
let screenStats = { sending: null, watching: [] };  // screen shares, the latest (measureScreens)
let lastScreenCounts = new Map();  // "out" or "in:<user id>" -> the counters last time
let voiceServer = "";   // LiveKit's address, e.g. "voice.example.com" (rooms.js, joinVoice)

function startConnectionStats() {
  stopConnectionStats();
  measureConnection();
  statsTimer = setInterval(measureConnection, STATS_SECONDS * 1000);
}

function stopConnectionStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  pingSamples = [];
  connection = null;
  lastCounts = null;
  screenStats = { sending: null, watching: [] };
  lastScreenCounts = new Map();
  voiceSignal.hidden = true;
  if (voiceStatsDialog.open) voiceStatsDialog.close();
}

// The route a report's packets take: its ping (ms) and "udp" or "tcp". Or null.
function routeOf(report) {
  if (!report) return null;
  let pair = null;
  for (const stat of report.values()) {
    if (stat.type === "transport" && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId);
  }
  // (Some browsers don't say which one is selected: then the one that's working.)
  if (!pair) {
    for (const stat of report.values()) {
      if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") pair = stat;
    }
  }
  if (!pair || pair.currentRoundTripTime === undefined) return null;
  const local = report.get(pair.localCandidateId);
  return { ping: Math.round(pair.currentRoundTripTime * 1000), protocol: local ? local.protocol : null };
}

// Lost packets as a % of all of them, since the last measurement. null if nothing was sent.
function lossPercent(lost, total, lastLost, lastTotal) {
  if (lastTotal === undefined) return null;      // the first measurement: nothing to compare with
  const newLost = Math.max(0, lost - lastLost);  // (Math.max: duplicates can make it count down)
  const newTotal = total - lastTotal;
  if (newTotal <= 0) return null;  // muted, nobody talking, or someone left (their counts went with them)
  return Math.min(100, (newLost / newTotal) * 100);
}

async function measureConnection() {
  const room = voiceRoom;
  if (!room) return;
  let sending;
  const receiving = [];
  try {
    // Our microphone's report (if we're sending one), and one for each voice we receive.
    if (micPublication && micPublication.track) sending = await micPublication.track.getRTCStatsReport();
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) receiving.push(await publication.track.getRTCStatsReport());
      }
    }
  } catch {
    return;  // (a track went away while we asked: next time)
  }
  if (voiceRoom !== room) return;  // left while measuring

  // Add up the counters: ours, and everyone's we receive.
  const counts = { sent: 0, lostOut: 0, received: 0, lostIn: 0 };
  for (const stat of sending ? sending.values() : []) {
    if (stat.type === "outbound-rtp") counts.sent += stat.packetsSent || 0;
    if (stat.type === "remote-inbound-rtp") counts.lostOut += stat.packetsLost || 0;
  }
  for (const report of receiving) {
    for (const stat of report ? report.values() : []) {
      if (stat.type === "inbound-rtp") {
        counts.received += stat.packetsReceived || 0;
        counts.lostIn += stat.packetsLost || 0;
      }
    }
  }
  const last = lastCounts || {};
  lastCounts = counts;

  // The route: from our microphone's report, or else from a voice we receive (listening only).
  const route = routeOf(sending) || receiving.map(routeOf).find(Boolean) || null;
  connection = {
    ping: route ? route.ping : null,
    protocol: route ? route.protocol : null,
    outLoss: lossPercent(counts.lostOut, counts.sent, last.lostOut, last.sent),
    // (Received plus lost: everything that was sent to us.)
    inLoss: lossPercent(counts.lostIn, counts.received + counts.lostIn, last.lostIn,
      last.received === undefined ? undefined : last.received + last.lostIn),
  };

  await measureScreens(room);
  if (voiceRoom !== room) return;

  const now = Date.now();
  if (connection.ping !== null) pingSamples.push({ time: now, ping: connection.ping });
  pingSamples = pingSamples.filter((sample) => sample.time > now - GRAPH_SECONDS * 1000);
  showSignal();
  if (voiceStatsDialog.open) renderConnectionStats();
}

// ----- Screen shares in the popup: how the one we send is doing, and the ones we watch.
//
// The same statistics, for video ("outbound-rtp" and "inbound-rtp" with kind "video"):
//   - frameWidth, frameHeight, framesPerSecond: what's actually being sent or shown right now
//   - qualityLimitationReason (sending): what's holding the encoder back: "cpu", "bandwidth"
//     or "none". The browser's own verdict.
//   - encoderImplementation / powerEfficientEncoder: which encoder is used; "power efficient"
//     means the graphics card's video chip (hardware), not the CPU. Same for decoding.
//   - codecId: points to a "codec" entry with the mimeType, like "video/H264"
//   - bytes, lost packets, dropped frames and freezes: counters, so again the difference with
//     5 seconds ago.

async function measureScreens(room) {
  const counts = new Map();
  const Source = LivekitClient.Track.Source;
  let sending = null;
  const watching = [];
  try {
    const mine = room.localParticipant.getTrackPublication(Source.ScreenShare);
    if (mine && mine.track) sending = videoStats(await mine.track.getRTCStatsReport(), "outbound-rtp", "out", counts);
    for (const participant of room.remoteParticipants.values()) {
      const theirs = participant.getTrackPublication(Source.ScreenShare);
      if (!theirs || !theirs.track) continue;  // not sharing, or we aren't receiving it
      const stats = videoStats(await theirs.track.getRTCStatsReport(), "inbound-rtp", "in:" + participant.identity, counts);
      if (stats) watching.push({ userId: participant.identity, ...stats });
    }
  } catch {
    return;  // (a share ended while we asked: next time)
  }
  lastScreenCounts = counts;
  screenStats = { sending, watching };
}

// One stream's numbers from a stats report. A screen we send can be several streams (a full one
// and a half-size one for slow connections): the counters add them all up, the rest is about the
// biggest one, the one you'd watch.
function videoStats(report, type, key, counts) {
  if (!report) return null;
  let main = null;
  const now = { time: Date.now(), bytes: 0, packets: 0, lost: 0, dropped: 0, freezes: 0 };
  for (const stat of report.values()) {
    if (stat.type !== type || stat.kind !== "video") continue;
    now.bytes += (stat.bytesSent ?? stat.bytesReceived) || 0;
    now.packets += (stat.packetsSent ?? stat.packetsReceived) || 0;
    now.lost += stat.packetsLost || 0;
    now.dropped += stat.framesDropped || 0;
    now.freezes += stat.freezeCount || 0;
    if (!main || (stat.frameHeight || 0) > (main.frameHeight || 0)) main = stat;
  }
  if (!main) return null;
  counts.set(key, now);
  const last = lastScreenCounts.get(key);
  const seconds = last ? (now.time - last.time) / 1000 : 0;
  const codec = report.get(main.codecId);
  return {
    width: main.frameWidth,
    height: main.frameHeight,
    fps: main.framesPerSecond,
    // Bits per second (bytes × 8), in megabits (millions): what the stream uses of the connection.
    mbps: seconds > 0 ? ((now.bytes - last.bytes) * 8) / seconds / 1e6 : null,
    codec: codec ? codec.mimeType.replace("video/", "") : null,
    // For H.264, which profile the call agreed on (like "42001f"): it decides whether Chromium
    // may use the graphics card (livekit.yaml).
    profile: codec?.sdpFmtpLine?.match(/profile-level-id=([0-9a-f]+)/i)?.[1] ?? null,
    hardware: main.powerEfficientEncoder ?? main.powerEfficientDecoder ?? null,  // true, false or unknown
    // The browser's own name for it, like "OpenH264" (CPU) or "MediaFoundationVideoEncodeAccelerator".
    implementation: main.encoderImplementation ?? main.decoderImplementation ?? null,
    limitedBy: main.qualityLimitationReason ?? null,
    // Only for what we receive: what got lost or dropped since last time.
    loss: type === "inbound-rtp" && last ? lossPercent(now.lost, now.packets + now.lost, last.lost, last.packets + last.lost) : null,
    dropped: last ? now.dropped - last.dropped : null,
    freezes: last ? now.freezes - last.freezes : null,
  };
}

// The screen share part of the popup: one block for ours, one for each we watch.
function renderScreenStats() {
  const box = document.getElementById("stat-screens");
  const blocks = [];
  if (screenStats.sending) blocks.push(screenBlock("Your screen share", screenStats.sending, true));
  for (const stats of screenStats.watching) {
    const name = people.get(Number(stats.userId))?.name ?? "Someone";
    blocks.push(screenBlock(name + "'s screen", stats, false));
  }
  box.replaceChildren(...blocks);
}

function screenBlock(title, stats, sending) {
  const block = document.createElement("div");
  block.className = "stat-screen";
  const line = (label, value) => {
    const p = document.createElement("p");
    p.append(label + ": ");
    const strong = document.createElement("strong");
    strong.textContent = value;
    p.appendChild(strong);
    block.appendChild(p);
  };
  const heading = document.createElement("p");
  heading.className = "stat-screen-title";
  heading.textContent = title;
  block.appendChild(heading);

  const size = stats.width ? `${stats.width}×${stats.height}` : "–";
  const fps = stats.fps === undefined ? "–" : Math.round(stats.fps) + " fps";
  line("Picture", `${size} at ${fps}`);
  line("Data", stats.mbps === null ? "–" : stats.mbps.toFixed(1) + " Mbit/s");
  const where = stats.hardware === true ? "graphics card" : stats.hardware === false ? "CPU" : null;
  const codec = stats.codec && stats.profile ? `${stats.codec} (${stats.profile})` : stats.codec;
  line(sending ? "Encoder" : "Decoder", [codec, where].filter(Boolean).join(", ") || "–");
  if (stats.implementation) line("Using", stats.implementation);
  if (sending) {
    const reasons = { none: "nothing", cpu: "the CPU (too slow)", bandwidth: "the connection", other: "something else" };
    line("Held back by", reasons[stats.limitedBy] ?? "–");
  } else {
    line("Packet loss", stats.loss === null ? "–" : stats.loss.toFixed(1) + "%");
    line("Dropped frames", stats.dropped === null ? "–" : String(stats.dropped));
    // The browser counts a "freeze" when a frame comes much later than usual. A screen share only
    // sends frames when something changes, so a still screen counts too: hence "pauses".
    line("Pauses", stats.freezes === null ? "–" : String(stats.freezes));
  }
  return block;
}

// "good" (green), "fair" (yellow) or "bad" (red), like Discord's signal icon.
function connectionQuality() {
  const ping = connection.ping ?? 0;
  const loss = Math.max(connection.outLoss ?? 0, connection.inLoss ?? 0);
  if (ping >= 250 || loss >= 10) return "bad";
  if (ping >= 100 || loss >= 2) return "fair";
  return "good";
}

function showSignal() {
  voiceSignal.hidden = connection.ping === null;
  voiceSignal.className = connectionQuality();
  voiceSignal.title = `Ping ${connection.ping} ms: connection details`;
}

// The popup, just above the voice bar (a modal dialog, so a click outside or Esc closes it,
// like the other popups: ui.js).
function openConnectionStats() {
  if (!statsTimer) return;  // not in voice (still connecting)
  renderConnectionStats();
  voiceStatsDialog.showModal();
  const bar = voiceBar.getBoundingClientRect();
  const width = voiceStatsDialog.offsetWidth;
  voiceStatsDialog.style.left = Math.max(8, Math.min(bar.left, innerWidth - width - 8)) + "px";
  voiceStatsDialog.style.bottom = (innerHeight - bar.top + 8) + "px";
}

voiceSignal.addEventListener("click", openConnectionStats);

function renderConnectionStats() {
  const percent = (value) => (value === null ? "–" : value.toFixed(1) + "%");
  const average = pingSamples.length
    ? Math.round(pingSamples.reduce((sum, sample) => sum + sample.ping, 0) / pingSamples.length) + " ms"
    : "–";
  document.getElementById("stat-server").textContent = voiceServer;
  document.getElementById("stat-protocol").textContent =
    connection.protocol === "udp" ? "UDP (direct)" : connection.protocol === "tcp" ? "TCP (fallback)" : "–";
  document.getElementById("stat-average").textContent = average;
  document.getElementById("stat-ping").textContent = connection.ping === null ? "–" : connection.ping + " ms";
  document.getElementById("stat-out-loss").textContent = percent(connection.outLoss);
  document.getElementById("stat-in-loss").textContent = percent(connection.inLoss);
  renderScreenStats();
  drawPingGraph();
}

// An SVG element (SVG elements need their own "namespace", so createElementNS, not createElement).
function svgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

// The graph: the last 5 minutes from left to right, the ping upwards. Its top is a round number
// a little above the highest ping (10, 20, 50, 100, ... ms), with a line and a label at the top,
// the middle and 0, and the time below at each whole minute. Drawn in the viewBox's own units
// (260 × 90): the browser scales it to the size the CSS gives it.
function drawPingGraph() {
  const plotWidth = 236, plotHeight = 74;  // room on the right for the ms labels, below for the times
  const now = Date.now();
  const start = now - GRAPH_SECONDS * 1000;
  const highest = Math.max(0, ...pingSamples.map((sample) => sample.ping));
  const top = [10, 20, 50, 100, 200, 500, 1000, 2000].find((step) => highest <= step) ?? Math.ceil(highest / 1000) * 1000;
  const x = (time) => ((time - start) / (GRAPH_SECONDS * 1000)) * plotWidth;
  const y = (ping) => plotHeight - (ping / top) * plotHeight;

  const parts = [];
  for (const value of [0, top / 2, top]) {
    parts.push(svgElement("line", { x1: 0, x2: plotWidth, y1: y(value), y2: y(value), class: "graph-grid" }));
    const label = svgElement("text", { x: plotWidth + 4, y: y(value) + 3, class: "graph-label" });
    label.textContent = value;
    parts.push(label);
  }
  // A time at each whole minute (60 000 ms) in the window, if it isn't squashed against an edge.
  for (let minute = Math.ceil(start / 60000) * 60000; minute <= now; minute += 60000) {
    if (x(minute) < 14 || x(minute) > plotWidth - 14) continue;
    const label = svgElement("text", { x: x(minute), y: 88, class: "graph-label", "text-anchor": "middle" });
    label.textContent = new Date(minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    parts.push(label);
  }
  // The line itself: "x,y x,y ..." through every measurement.
  const points = pingSamples.map((sample) => `${x(sample.time).toFixed(1)},${y(sample.ping).toFixed(1)}`);
  parts.push(svgElement("polyline", { points: points.join(" "), class: "graph-line" }));
  pingGraph.replaceChildren(...parts);
}
