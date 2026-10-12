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
  micTesting = false;
  showTestButton();
  closeMicIfUnused();
  stopCameraPreview();
}

settingsButton.addEventListener("click", listDevices);
settingsDialog.addEventListener("close", stopSettingsTests);
