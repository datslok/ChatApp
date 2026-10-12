// The camera and screen sharing (both sent through LiveKit, like the microphone).
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ----- The camera
//
// LiveKit opens the camera for us (setCameraEnabled): unlike the microphone, it doesn't go through
// our own chain. Turning it off "mutes" it, which also releases the camera, so its light goes out.

async function toggleCamera() {
  const room = voiceRoom;
  if (!room || room.state !== "connected") return;
  const turnOn = !cameraOn;
  try {
    await room.localParticipant.setCameraEnabled(turnOn);  // the first time, the browser asks
    cameraOn = turnOn;
  } catch {
    cameraOn = false;  // not allowed, no camera, or it's in use by another program
    setVoiceStatus("No camera access", "error");
    voiceStatus.title = "The browser didn't allow the camera, or another program is using it.";
  }
  showCameraButtons();
  renderCallPanel();
}

function showCameraButtons() {
  for (const button of [voiceCameraButton, callPanelCamera, loungeCamera]) {
    button.classList.toggle("on", cameraOn);
    button.title = cameraOn ? "Turn off camera" : "Turn on camera";
    button.setAttribute("aria-label", button.title);
  }
}

voiceCameraButton.addEventListener("click", toggleCamera);

// Someone's camera track, if it's on and has reached us (ours: if it's on), or null.
function cameraTrack(userId) {
  if (!voiceRoom) return null;
  const participant = userId === myId
    ? voiceRoom.localParticipant
    : voiceRoom.remoteParticipants.get(String(userId));
  const publication = participant && participant.getTrackPublication(LivekitClient.Track.Source.Camera);
  return publication && publication.track && !publication.isMuted ? publication.track : null;
}

// A <video> showing this track. Reused if it already has one, so redrawing the banner doesn't
// keep making new ones (each attach() makes another).
// look: its class, "tile-video" (filling a tile) unless said otherwise.
function videoFor(track, mine, look = "tile-video") {
  const video = track.attachedElements[0] || track.attach();
  video.className = mine ? look + " mine" : look;
  return video;
}

// ----- Screen sharing
//
// getDisplayMedia (through LiveKit's setScreenShareEnabled) lets the browser show its own picker:
// a whole screen, a window or a tab. To LiveKit it's one more video track (source "screen_share"),
// plus an audio track ("screen_share_audio") if "Share audio" was ticked in the picker.

const voiceShareButton = document.getElementById("voice-share");
const callPanelShare = document.getElementById("call-panel-share");
const loungeShare = document.getElementById("lounge-share");
const shareMenu = document.getElementById("share-menu");
const shareHelp = document.getElementById("share-help");
let sharing = false;

// How much to send per second, for each resolution and frame rate: enough to keep text sharp
// (and moving pictures smooth at 60). Everyone watching gets this much (or less, with simulcast).
const SHARE_BITRATES = {
  720: { 30: 2_500_000, 60: 4_000_000 },
  1080: { 30: 5_000_000, 60: 8_000_000 },
  1440: { 30: 8_000_000, 60: 12_000_000 },
};

// Phone browsers can't share their screen: no button there (they can still watch).
const canShareScreen = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

function showShareButtons() {
  // (The banner's and the Lounge page's buttons are shown and hidden with the rest of their
  // buttons, in renderCallPanel and renderLoungeView.)
  voiceShareButton.hidden = !canShareScreen;
  for (const button of [voiceShareButton, callPanelShare, loungeShare]) {
    button.classList.toggle("on", sharing);
    button.title = sharing ? "Stop sharing" : "Share your screen";
    button.setAttribute("aria-label", button.title);
  }
}

// The screen's real size in pixels (CSS pixels times Windows' scaling, like 125%).
function screenHeight() {
  return Math.round(screen.height * devicePixelRatio);
}

// 🖥️: stop sharing, or open the quality menu (with the last choice ticked, and resolutions
// above this screen's own greyed out).
function shareButtonClicked() {
  if (sharing) {
    stopScreenShare();
    return;
  }
  const native = screenHeight();
  for (const radio of shareMenu.querySelectorAll('input[name="share-height"]')) {
    radio.disabled = Number(radio.value) > native && radio.value !== "720";  // 720p always works
  }
  // The saved choice, or the biggest one this screen allows.
  let height = voiceSettings.shareHeight;
  if (height > native) height = native >= 1080 ? 1080 : 720;
  shareMenu.querySelector(`input[name="share-height"][value="${height}"]`).checked = true;
  shareMenu.querySelector(`input[name="share-fps"][value="${voiceSettings.shareFps}"]`).checked = true;
  showShareHelp();
  shareMenu.showModal();
}

function showShareHelp() {
  const height = Number(shareMenu.querySelector('input[name="share-height"]:checked').value);
  const fps = Number(shareMenu.querySelector('input[name="share-fps"]:checked').value);
  const megabits = SHARE_BITRATES[height][fps] / 1_000_000;
  shareHelp.textContent = `About ${megabits} Mbit/s for each person watching. Your screen: ${screenHeight()}p.`;
}
shareMenu.addEventListener("change", showShareHelp);  // a radio button was picked

for (const button of [voiceShareButton, callPanelShare, loungeShare]) {
  button.addEventListener("click", shareButtonClicked);
}
document.getElementById("share-cancel").addEventListener("click", () => shareMenu.close());

document.getElementById("share-start").addEventListener("click", async () => {
  voiceSettings.shareHeight = Number(shareMenu.querySelector('input[name="share-height"]:checked').value);
  voiceSettings.shareFps = Number(shareMenu.querySelector('input[name="share-fps"]:checked').value);
  saveVoiceSettings();
  shareMenu.close();
  // Straight away, still inside this click: browsers only open their screen picker right after
  // a click.
  await startScreenShare();
});

async function startScreenShare() {
  const room = voiceRoom;
  if (!room || room.state !== "connected") return;
  const height = voiceSettings.shareHeight;
  const fps = voiceSettings.shareFps;
  try {
    await room.localParticipant.setScreenShareEnabled(true, {
      // What the browser captures: at most this size and frame rate.
      resolution: { width: Math.round((height * 16) / 9), height, frameRate: fps },
      // Shows "Share audio" in the picker. A whole screen's sound is everything the PC plays,
      // including the call itself, so people would hear themselves back: restrictOwnAudio leaves
      // out the sound this page plays. (Browsers without it ignore it and capture everything.)
      audio: { restrictOwnAudio: true },
      systemAudio: "include",    // ...also when sharing a whole screen, not only a tab
      // A hint for the video encoder: keep text crisp ("detail"), or keep movement smooth ("motion").
      contentHint: fps === 60 ? "motion" : "detail",
    }, {
      // H.264 instead of LiveKit's default, VP8. Browsers encode VP8 on the CPU, which a game is
      // already using; for H.264, nearly every graphics card has a chip of its own (NVENC, VCN,
      // Quick Sync), like Discord's "H.264 hardware acceleration". The browser uses it if it's
      // there, and otherwise encodes H.264 on the CPU. (The connection popup shows which.)
      videoCodec: "h264",
      // One version of the screen, not also a half-size one for slow connections ("simulcast",
      // which cameras keep). Graphics cards' H.264 encoders generally can't make two at once,
      // so with simulcast the browser falls back to the CPU. Dynacast still pauses it when
      // nobody's watching.
      simulcast: false,
      screenShareEncoding: { maxBitrate: SHARE_BITRATES[height][fps], maxFramerate: fps },
      // When the encoder or the connection can't keep up, something has to give. LiveKit's
      // default for screens keeps the resolution and drops frames: right for text (30 fps),
      // but a game at 60 should rather stay smooth and get a little less sharp.
      degradationPreference: fps === 60 ? "maintain-framerate" : "maintain-resolution",
    });
    sharing = room.localParticipant.isScreenShareEnabled;
  } catch (error) {
    sharing = false;
    // Pressing Cancel in the browser's picker counts as "not allowed": that's not an error.
    if (error.name !== "NotAllowedError") setVoiceStatus("Couldn't share the screen", "error");
  }
  showShareButtons();
  renderCallPanel();
}

async function stopScreenShare() {
  if (voiceRoom) await voiceRoom.localParticipant.setScreenShareEnabled(false).catch(() => {});
  sharing = false;
  showShareButtons();
  renderCallPanel();
}

// Someone's shared screen, if they're sharing and it has reached us (ours: if we're sharing).
function screenTrack(userId) {
  if (!voiceRoom) return null;
  const participant = userId === myId
    ? voiceRoom.localParticipant
    : voiceRoom.remoteParticipants.get(String(userId));
  const publication = participant && participant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
  return publication && publication.track && !publication.isMuted ? publication.track : null;
}

// Does someone else's shared screen come with sound ("Share audio" ticked in their picker),
// and has it reached us? (We never hear our own.)
function screenHasSound(userId) {
  if (!voiceRoom || userId === myId) return false;
  const participant = voiceRoom.remoteParticipants.get(String(userId));
  const publication = participant && participant.getTrackPublication(LivekitClient.Track.Source.ScreenShareAudio);
  return Boolean(publication && publication.track);
}

showShareButtons();
