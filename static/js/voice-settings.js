// Settings: Voice & audio (devices, volumes, the sensitivity meter) and Video.
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ----- Settings: Voice & audio

// Fill a device list. new Option(text, value) sets the text as plain text, never as HTML.
function fillDeviceSelect(select, devices, chosen, fallbackName) {
  const options = [new Option("Default", "")];
  let number = 0;
  for (const device of devices) {
    // Chrome also lists the defaults as "default" and "communications": we have our own Default.
    // (Before the microphone is allowed, the ids are empty: then only Default.)
    if (!device.deviceId || device.deviceId === "default" || device.deviceId === "communications") continue;
    number += 1;
    options.push(new Option(device.label || `${fallbackName} ${number}`, device.deviceId));
  }
  select.replaceChildren(...options);
  select.value = options.some((option) => option.value === chosen) ? chosen : "";
}

async function listDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  fillDeviceSelect(voiceInputSelect, devices.filter((d) => d.kind === "audioinput"), voiceSettings.inputDevice, "Microphone");
  fillDeviceSelect(voiceOutputSelect, devices.filter((d) => d.kind === "audiooutput"), voiceSettings.outputDevice, "Speakers");
  fillDeviceSelect(cameraSelect, devices.filter((d) => d.kind === "videoinput"), voiceSettings.cameraDevice, "Camera");
  // Browsers only show the devices' names once the page may use the microphone.
  voiceDevicesHelp.textContent = devices.some((d) => d.label)
    ? ""
    : "Press Test microphone (or join voice) to see your devices' names.";
}

// Browsers only tell a page which microphones and speakers there are (and their names) once it may use
// the microphone. So when Voice & audio opens without that (settings.js, showSettingsPage): open the
// microphone for a moment (the browser asks the first time; the Windows app may ask again after a
// restart), close it straight away, and list them. Not for cameras: that would switch the camera light on.
async function unlockDevices() {
  if (!navigator.mediaDevices || micStream) return;  // (open already: the names are there)
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  if (devices.some((device) => device.kind === "audioinput" && device.label)) return;  // allowed already
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();  // only needed it for the permission
  } catch {
    return;  // refused (or no microphone): the hint under the lists stays
  }
  listDevices();
}

// Plugging in or out a headset: the lists change.
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", listDevices);

// Choosing speakers only works where the browser can do it (not on iPhones or in Firefox).
voiceOutputRow.hidden = !(window.AudioContext && "setSinkId" in AudioContext.prototype);

voiceInputSelect.addEventListener("change", async () => {
  voiceSettings.inputDevice = voiceInputSelect.value;
  saveVoiceSettings();
  // Switch the open microphone. Only the start of the chain changes, so a call carries on.
  if (micStream) await openMic().catch(() => {});
});

// Noise suppression: Off, Light or On (voice.js, openMic). Changing it opens the microphone again
// with the new choice, the same way as switching microphones, so a call carries on.
const voiceNoiseSelect = document.getElementById("voice-noise");
voiceNoiseSelect.value = voiceSettings.noiseSuppression;
voiceNoiseSelect.addEventListener("change", async () => {
  voiceSettings.noiseSuppression = voiceNoiseSelect.value;
  saveVoiceSettings();
  if (micStream) await openMic().catch(() => {});
});

voiceOutputSelect.addEventListener("change", async () => {
  voiceSettings.outputDevice = voiceOutputSelect.value;
  saveVoiceSettings();
  if (voiceEngine) applyOutputDevice((await getAudio()).context);
});

function showVolumes() {
  voiceMicVolumeSlider.value = voiceSettings.micVolume;
  voiceMicVolumeValue.textContent = voiceSettings.micVolume + "%";
  voiceOutputVolumeSlider.value = voiceSettings.outputVolume;
  voiceOutputVolumeValue.textContent = voiceSettings.outputVolume + "%";
  voiceGateSlider.value = voiceSettings.gate;
  showGateReadout();
}
showVolumes();

voiceMicVolumeSlider.addEventListener("input", async () => {
  voiceSettings.micVolume = Number(voiceMicVolumeSlider.value);
  showVolumes();
  saveVoiceSettings();
  if (voiceEngine) {
    const { context, micGain } = await getAudio();
    micGain.gain.setTargetAtTime(voiceSettings.micVolume / 100, context.currentTime, 0.02);  // glide, no clicks
  }
});

voiceOutputVolumeSlider.addEventListener("input", () => {
  voiceSettings.outputVolume = Number(voiceOutputVolumeSlider.value);
  showVolumes();
  saveVoiceSettings();
  if (voiceRoom) {
    for (const participant of voiceRoom.remoteParticipants.values()) applyVolume(participant);
  }
});

voiceGateSlider.addEventListener("input", async () => {
  voiceSettings.gate = Number(voiceGateSlider.value);
  saveVoiceSettings();
  showGateReadout();  // straight away while dragging, not only with the next level report
  if (voiceEngine) (await getAudio()).gate.port.postMessage({ threshold: voiceSettings.gate });
});

// ----- Input mode: voice activity or push to talk (voice.js, "Push to talk")

const voiceModeRow = document.getElementById("voice-mode-row");
const voiceModeSelect = document.getElementById("voice-mode");
const voicePttRow = document.getElementById("voice-ptt-row");
const voicePttHelp = document.getElementById("voice-ptt-help");
const voicePttKeyButton = document.getElementById("voice-ptt-key");
const voiceMeterTitle = document.getElementById("voice-meter-title");
const voiceGateHelp = document.getElementById("voice-gate-help");

// Phones have no keys to hold, so no push to talk there (voiceSettings is kept per device anyway).
voiceModeRow.hidden = onPhone;

// Show the mode's own controls: the key for push to talk, the sensitivity line for voice activity.
// The meter stays in both: with push to talk it turns green while you hold the key.
function showInputMode() {
  const ptt = voiceSettings.inputMode === "ptt";
  voiceModeSelect.value = voiceSettings.inputMode;
  voicePttRow.hidden = !ptt;
  voicePttHelp.hidden = !ptt;
  voiceGateSlider.hidden = ptt;
  voiceGateHelp.hidden = ptt;
  voiceMeterTitle.textContent = ptt
    ? "Your microphone: green while it's on"
    : "Sensitivity: when the bar is left of the line, your microphone is silent";
  voicePttKeyButton.textContent = pttWaiting ? "Press a key…" : voiceSettings.pttName || "Set key";
  voicePttKeyButton.classList.toggle("waiting", pttWaiting);
  showGateReadout();
}
showInputMode();

voiceModeSelect.addEventListener("change", () => {
  voiceSettings.inputMode = voiceModeSelect.value;
  saveVoiceSettings();
  stopWaitingForKey();
  showInputMode();
  updatePushToTalk();       // the gate switches straight away, also in a call
  tellAppPushToTalkKey();   // the app starts (or stops) watching the key
});

// "Set key": the next key or mouse button (middle, back or forward) becomes the push-to-talk key.
// Esc, or a left or right click, cancels. The listeners are on window and in the "capture" phase:
// they get the event before anything else on the page, so Esc doesn't also close Settings.
voicePttKeyButton.addEventListener("click", () => {
  if (pttWaiting) return;
  pttWaiting = true;
  window.addEventListener("keydown", pickKey, true);
  window.addEventListener("mousedown", pickButton, true);
  showInputMode();
});

function stopWaitingForKey() {
  pttWaiting = false;
  window.removeEventListener("keydown", pickKey, true);
  window.removeEventListener("mousedown", pickButton, true);
  showInputMode();
}

function pickKey(event) {
  event.preventDefault();   // no typing, scrolling or closing anything with it
  event.stopPropagation();  // and nobody else on the page sees it
  if (event.code === "Escape" || !event.code) {
    stopWaitingForKey();
    return;
  }
  // The name: what the key types ("V", "Ø"), else its code with spaces ("ShiftLeft" -> "Shift Left").
  let name = event.code.replace(/([a-z])([A-Z0-9])/g, "$1 $2");
  if (event.key === " ") name = "Space";
  else if (event.key.length === 1) name = event.key.toUpperCase();
  // keyCode: an old part of key events, but in Chrome on Windows it's exactly Windows' own number for
  // the key on this keyboard layout, which the app needs (voice.js, tellAppPushToTalkKey).
  setPushToTalkKey(event.code, event.keyCode, name);
}

const MOUSE_BUTTONS = { 1: ["Middle mouse button", 0x04], 3: ["Mouse back button", 0x05], 4: ["Mouse forward button", 0x06] };

function pickButton(event) {
  const button = MOUSE_BUTTONS[event.button];
  if (!button) {  // left or right: cancel (and let the click do what it does)
    stopWaitingForKey();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setPushToTalkKey("Mouse" + event.button, button[1], button[0]);
}

function setPushToTalkKey(code, windowsKey, name) {
  voiceSettings.pttKey = code;
  voiceSettings.pttWindowsKey = windowsKey;
  voiceSettings.pttName = name;
  saveVoiceSettings();
  stopWaitingForKey();
  tellAppPushToTalkKey();
}

function showTestButton() {
  voiceTestButton.textContent = micTesting ? "Stop test" : "Test microphone";
}

const voiceTestStatus = document.getElementById("voice-test-status");

voiceTestButton.addEventListener("click", async () => {
  micTesting = !micTesting;
  showTestButton();
  voiceTestStatus.textContent = "";
  if (!micTesting) {
    closeMicIfUnused();
    return;
  }
  try {
    if (!micStream) await openMic();
  } catch (error) {
    micTesting = false;
    showTestButton();
    voiceTestStatus.textContent = describeMediaError(error, "microphone");  // (voice.js)
  }
});

// ----- Settings: Video

const cameraSelect = document.getElementById("camera-input");
const cameraPreview = document.getElementById("camera-preview");
const cameraTestButton = document.getElementById("camera-test");
let previewStream = null;  // the camera, opened for the preview, while "Test camera" is on

async function startCameraPreview() {
  stopCameraPreview();
  previewStream = await navigator.mediaDevices.getUserMedia({
    video: voiceSettings.cameraDevice ? { deviceId: { ideal: voiceSettings.cameraDevice } } : true,
  });
  cameraPreview.srcObject = previewStream;  // a <video> can show a live stream directly
  // Mirrored if it faces us; a phone's back camera isn't (video.js, facesUser).
  cameraPreview.classList.toggle("mirrored", facesUser(previewStream.getVideoTracks()[0]));
  cameraPreview.hidden = false;
  cameraTestButton.textContent = "Stop camera test";
  listDevices();  // now the browser tells us the cameras' names
}

function stopCameraPreview() {
  if (previewStream) {
    for (const track of previewStream.getTracks()) track.stop();  // the camera's light goes out
  }
  previewStream = null;
  cameraPreview.srcObject = null;
  cameraPreview.hidden = true;
  cameraTestButton.textContent = "Test camera";
}

const cameraTestStatus = document.getElementById("camera-test-status");

cameraTestButton.addEventListener("click", async () => {
  cameraTestStatus.textContent = "";
  if (previewStream) {
    stopCameraPreview();
    return;
  }
  try {
    await startCameraPreview();
  } catch (error) {
    stopCameraPreview();
    cameraTestStatus.textContent = describeMediaError(error, "camera");  // (voice.js)
  }
});

cameraSelect.addEventListener("change", async () => {
  voiceSettings.cameraDevice = cameraSelect.value;
  saveVoiceSettings();
  if (previewStream) startCameraPreview().catch(stopCameraPreview);  // show the new one
  // In a call with the camera on: switch it there too ("Default" leaves the current one).
  if (voiceRoom && cameraOn && cameraSelect.value) {
    // Then draw the tiles again: from the front camera to the back one, ours stops being mirrored.
    voiceRoom.switchActiveDevice("videoinput", cameraSelect.value).then(renderCallPanel, () => {});
  }
});

// Opening Settings: fresh device lists. Closing it, or going to another tab (settings.js): stop
// the tests, so the microphone or camera doesn't stay on unseen. (In a call, the microphone
// stays open: closeMicIfUnused only closes it when nothing needs it.)
function stopSettingsTests() {
  if (pttWaiting) stopWaitingForKey();
  micTesting = false;
  showTestButton();
  closeMicIfUnused();
  stopCameraPreview();
}

settingsButton.addEventListener("click", listDevices);
settingsDialog.addEventListener("close", stopSettingsTests);
