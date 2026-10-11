// Joining and leaving voice rooms, calls in DMs (ringing, the call banner), and the
// Lounge page.
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ----- Joining and leaving

// The status line in the voice bar. kind: "" (green), "waiting" (yellow) or "error" (red).
function setVoiceStatus(text, kind = "") {
  voiceStatus.textContent = text;
  voiceStatus.className = kind;
}

// Mark the voice channel we're in (green in the sidebar).
function markVoiceChannel() {
  for (const button of document.querySelectorAll(".voice-channel")) {
    button.classList.toggle("in-voice", button.dataset.room === voiceRoomName);
  }
  showDmHeader();  // "📞 In call" when it's this DM's call
}

function showMuteButton() {
  voiceMuteButton.classList.toggle("off", micMuted);
  voiceMuteButton.title = micMuted ? "Unmute" : "Mute";
  voiceMuteButton.setAttribute("aria-label", voiceMuteButton.title);
  sendVoiceState();  // the 🔇 next to our name
  renderCallPanel();  // ...and in the call banner
}

// LiveKit's library normally loads with the page (the <script> tag near the top). If that went
// wrong (the page was opened while the server didn't have it, and that error got cached), load
// it once more, from an address with "?retry=..." on the end: a new address, so no cache can
// answer with the old error. Our server ignores the extra part and sends the same file.
function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/livekit-client-2.22.3.umd.js?retry=" + Date.now();
    script.addEventListener("load", () => {
      if (window.LivekitClient) resolve();
      else reject(new Error("Couldn't load voice"));
    });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("Couldn't load voice (offline, or blocked?)"));
    });
    document.head.appendChild(script);
  });
}

async function joinVoice(roomName, label) {
  if (voiceRoomName === roomName) return;  // already there
  if (voiceRoom) leaveVoice();             // one voice room at a time
  voiceRoomName = roomName;
  voiceBar.hidden = false;
  voiceWhere.textContent = label;
  voiceStatus.title = "";
  setVoiceStatus("Connecting…", "waiting");
  markVoiceChannel();
  showMuteButton();

  let room;
  try {
    await loadLiveKit();
    const { context } = await getAudio();
    if (voiceRoomName !== roomName) return;  // left (or went elsewhere) while waiting
    room = new LivekitClient.Room({
      // Play the others through our AudioContext, so their volume can go above 100% and the
      // speakers can be chosen.
      webAudioMix: { audioContext: context },
      // Leaving unpublishes our microphone track; keep it working for the next call.
      stopLocalTrackOnUnpublish: false,
      // Video. Cameras send a small, a medium and a large version at once ("simulcast", on by
      // default), and each viewer gets only the size it shows: adaptiveStream tells LiveKit how
      // big our video elements are (and that hidden ones need nothing), dynacast stops sending
      // the versions nobody watches. Our camera: 1280x720.
      adaptiveStream: true,
      dynacast: true,
      // (The camera chosen in Settings, if any: undefined means the default.)
      videoCaptureDefaults: {
        resolution: LivekitClient.VideoPresets.h720.resolution,
        deviceId: voiceSettings.cameraDevice || undefined,
      },
    });
    voiceRoom = room;

    // Someone else's audio has reached us: track.attach() starts playing it. Their camera: the
    // call banner shows it (renderCallPanel attaches it to a <video> there).
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === "video") {
        renderCallPanel();
        return;
      }
      voiceAudio.appendChild(track.attach());
      applyVolume(participant);
    });
    // ...and when they leave or stop sending, stop it again.
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) element.remove();
      renderCallPanel();
    });
    // A camera turned off or on (LiveKit "mutes" a camera that's off), ours or theirs.
    for (const event of ["TrackMuted", "TrackUnmuted", "LocalTrackPublished", "LocalTrackUnpublished"]) {
      room.on(LivekitClient.RoomEvent[event], renderCallPanel);
    }
    // Our screen share ended from outside our buttons (the browser's "Stop sharing" bar, or the
    // shared window closed): LiveKit unpublishes it, and our buttons follow.
    room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === LivekitClient.Track.Source.ScreenShare) {
        sharing = false;
        showShareButtons();
      }
    });
    // The connection dropped: LiveKit tries to get it back by itself.
    room.on(LivekitClient.RoomEvent.Reconnecting, () => setVoiceStatus("Reconnecting…", "waiting"));
    room.on(LivekitClient.RoomEvent.Reconnected, () => setVoiceStatus("Voice connected"));
    // Someone joined or left the room: their picture in the call banner lights up or fades.
    // In a DM call, that's the call starting or ending: a cue. (Not in Lounge: too many sounds.)
    room.on(LivekitClient.RoomEvent.ParticipantConnected, () => {
      renderCallPanel();
      if (roomName.startsWith("dm:")) playVoiceCue("join");
    });
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => {
      renderCallPanel();
      if (roomName.startsWith("dm:")) playVoiceCue("leave");
    });
    // Who's talking: LiveKit measures it on the server and tells everyone in the room.
    room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      speakingIds = new Set(speakers.map((participant) => participant.identity));
      showSpeaking();
    });
    // Disconnected for good (gave up reconnecting, or joined from another tab with the same account).
    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      if (voiceRoom === room) leaveVoice();
    });
    // Browsers only play sound after you've clicked something on the page. Joining is a click,
    // but if connecting took long, the browser may have stopped counting it: then ask for one more.
    room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) {
        setVoiceStatus("Tap here to turn on sound", "waiting");
        voiceStatus.classList.add("clickable");
      }
    });

    // Our server checks that we may join, and gives us LiveKit's address and a ticket.
    const response = await fetch("/voice-token?room=" + encodeURIComponent(roomName));
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.detail || "Couldn't join voice.");
    await room.connect(answer.url, answer.token);
  } catch (error) {
    if (voiceRoomName !== roomName || (room && voiceRoom !== room)) return;  // we left meanwhile
    if (room) room.disconnect(false);  // false: don't stop our microphone track (see sendMic)
    voiceRoom = null;
    voiceRoomName = null;
    markVoiceChannel();
    setVoiceStatus(error.message || "Couldn't connect to voice", "error");
    return;
  }
  if (voiceRoom !== room) {
    room.disconnect(false);  // we left while it was connecting
    return;
  }
  setVoiceStatus(outgoingCall === roomName ? "Calling…" : "Voice connected");
  sendVoiceState();  // we're in: show us under the channel
  // We're in: the join cue. Except while our own call still rings: then the cue comes when
  // they arrive (ParticipantConnected above), and until then there's the calling sound.
  if (outgoingCall !== roomName) playVoiceCue("join");

  // The microphone. The first time, the browser asks whether we may use it. Without it you can
  // still listen (and the mute button stays red).
  if (!micMuted) {
    try {
      await sendMic(room);
    } catch {
      if (voiceRoom === room) showNoMicrophone();
    }
  }
}

function leaveVoice() {
  if (outgoingCall) {
    sendToServer({ type: "call_cancel", channel: outgoingCall });  // hung up before an answer
    setOutgoingCall(null);
  }
  const room = voiceRoom;
  // Only a real leave gets the cue: not a failed or cancelled attempt to connect.
  if (room && room.state === "connected") playVoiceCue("leave");
  // The camera: disconnect(false) below leaves our tracks running, so stop it ourselves (its
  // light goes out). It's off again next time we join.
  const camera = room && room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
  if (camera && camera.track) camera.track.stop();
  cameraOn = false;
  showCameraButtons();
  // The same for a screen share (and its sound): stop capturing.
  for (const source of [LivekitClient.Track.Source.ScreenShare, LivekitClient.Track.Source.ScreenShareAudio]) {
    const publication = room && room.localParticipant.getTrackPublication(source);
    if (publication && publication.track) publication.track.stop();
  }
  sharing = false;
  showShareButtons();
  voiceRoom = null;
  voiceRoomName = null;
  micPublication = null;
  if (room) room.disconnect(false);  // false: LiveKit would otherwise stop our microphone track for good
  closeMicIfUnused();  // the "mic in use" light goes out (unless Settings is testing it)
  voiceAudio.replaceChildren();  // remove every <audio> element
  voiceBar.hidden = true;
  voiceStatus.title = "";
  markVoiceChannel();
  speakingIds.clear();
  showSpeaking();
  sendVoiceState();  // we're out
  // Skipped during the call, so now (core.js). A moment later: when leaving is part of joining
  // another room (joinVoice, Call, Accept), that room is set by then, and the check is skipped.
  setTimeout(checkForAppUpdate, 0);
}

// Clicking a voice channel opens its page, and joins it (unless we're in it already).
for (const button of document.querySelectorAll(".voice-channel")) {
  button.addEventListener("click", () => {
    const label = button.textContent.replace("🔊", "").trim();
    switchChannel(button.dataset.channel, label);
    if (voiceRoomName !== button.dataset.room) joinVoice(button.dataset.room, label);
  });
}

voiceLeaveButton.addEventListener("click", leaveVoice);

voiceMuteButton.addEventListener("click", async () => {
  micMuted = !micMuted;
  showMuteButton();
  const room = voiceRoom;
  if (!room || room.state !== "connected") return;  // takes effect once connected
  if (micMuted) {
    if (micPublication) await micPublication.mute();  // send silence (the microphone stays open)
    return;
  }
  try {
    await sendMic(room);
    setVoiceStatus("Voice connected");
    voiceStatus.title = "";
  } catch {
    if (voiceRoom === room) showNoMicrophone();
  }
});

// The "Tap here to turn on sound" case: this click lets the browser play the others' audio.
voiceStatus.addEventListener("click", async () => {
  if (!voiceRoom || !voiceStatus.classList.contains("clickable")) return;
  await voiceRoom.startAudio();
  voiceStatus.classList.remove("clickable");
  setVoiceStatus("Voice connected");
});

// ----- DM calls
//
// A DM call is a voice room named after the DM ("dm:3:7"), joined like Lounge. What's new is the
// ringing, which our server passes along over the chat's WebSocket (see "DM calls" in server.py).

const dmHeader = document.getElementById("dm-header");
const dmHeaderName = document.getElementById("dm-header-name");
const callButton = document.getElementById("call-button");
const incomingCallDialog = document.getElementById("incoming-call");
const incomingCallAvatar = document.getElementById("incoming-call-avatar");
const incomingCallName = document.getElementById("incoming-call-name");
const callAcceptButton = document.getElementById("call-accept");
const callDeclineButton = document.getElementById("call-decline");

let outgoingCall = null;      // the DM we're calling, while it rings
let incomingCall = null;      // {channel, from, name}: ringing for us
let ringTimer = null;         // repeats the ringtone every 2 seconds
let callNotification = null;  // the desktop notification for it

// ----- The call banner at the top of a DM (like Discord's): both pictures, mute and end call,
// or "Join call" when the other person is in the call and we aren't.

const callPanel = document.getElementById("call-panel");
const callTiles = document.getElementById("call-tiles");
const callPanelMute = document.getElementById("call-panel-mute");
const callPanelCamera = document.getElementById("call-panel-camera");
const callPanelEnd = document.getElementById("call-panel-end");
const callPanelJoin = document.getElementById("call-panel-join");
const callPanelFullscreen = document.getElementById("call-panel-fullscreen");

// Who's in our DMs' calls, from the server: {"dm:3:7": [{id: 7, muted: false}]}.
let dmCalls = {};

function renderCallPanel() {
  renderLoungeView();  // (the Lounge page changes at the same moments)
  const channel = currentChannel;
  const partner = dmPartner(channel);
  const members = dmCalls[channel] || [];
  const inCall = partner !== null && voiceRoomName === channel;
  // Only in a DM, and only while someone is in its call.
  callPanel.hidden = partner === null || (!inCall && members.length === 0);
  if (callPanel.hidden) {
    if (document.fullscreenElement === callPanel) document.exitFullscreen().catch(() => {});  // the call ended
    return;
  }

  const partnerMember = members.find((member) => member.id === partner);
  // In the call ourselves, LiveKit knows best whether they're there; otherwise, the server.
  const partnerHere = inCall
    ? Boolean(voiceRoom && voiceRoom.remoteParticipants.has(String(partner)))
    : Boolean(partnerMember);
  // Shared screens first (ours too, so we see what they see; only while we're in the call),
  // then both of us: faded while not in the call, "Calling…" while it rings.
  const screens = inCall ? [myId, partner].filter((id) => screenTrack(id)).map(makeScreenTile) : [];
  showTiles(callTiles, [
    ...screens,
    makeTile(myId, { muted: inCall && micMuted, video: inCall ? cameraTrack(myId) : null, away: !inCall }),
    makeTile(partner, {
      muted: partnerHere && Boolean(partnerMember && partnerMember.muted),
      video: inCall && partnerHere ? cameraTrack(partner) : null,  // (only while we're in the call too)
      away: !partnerHere,
      note: !partnerHere && outgoingCall === channel ? "Calling…" : "",
    }),
  ]);
  callPanelFullscreen.hidden = !inCall;
  callPanelMute.hidden = !inCall;
  callPanelCamera.hidden = !inCall;
  callPanelShare.hidden = !inCall || !canShareScreen;
  callPanelEnd.hidden = !inCall;
  callPanelJoin.hidden = inCall;
  callPanelMute.classList.toggle("off", micMuted);
  callPanelMute.title = micMuted ? "Unmute" : "Mute";
  callPanelMute.setAttribute("aria-label", callPanelMute.title);
  showSpeaking();  // the rings
}

callPanelMute.addEventListener("click", () => voiceMuteButton.click());  // the same as the voice bar's
callPanelCamera.addEventListener("click", toggleCamera);
callPanelEnd.addEventListener("click", leaveVoice);
callPanelJoin.addEventListener("click", () => joinVoice(currentChannel, channelLabel(currentChannel)));

// The bar at the top of a DM, with the call button ("In call" while we're in that DM's call).
function showDmHeader() {
  renderCallPanel();  // (the banner below it changes at the same moments)
  const inDm = dmPartner(currentChannel) !== null;
  dmHeader.hidden = !inDm;
  if (!inDm) return;
  dmHeaderName.textContent = channelLabel(currentChannel);
  const inThisCall = voiceRoomName === currentChannel;
  callButton.disabled = inThisCall;
  callButton.textContent = inThisCall ? "📞 In call" : "📞 Call";
}

callButton.addEventListener("click", async () => {
  const channel = currentChannel;
  if (voiceRoom) leaveVoice();  // leave Lounge (or another call) first, so leaving doesn't hang up this one
  setOutgoingCall(channel);
  sendToServer({ type: "call", channel });  // their tabs start ringing
  await joinVoice(channel, channelLabel(channel));
  if (outgoingCall !== channel) return;  // answered, declined or hung up meanwhile
  if (voiceRoomName === channel) {
    setVoiceStatus("Calling…", "waiting");
    startCallingSound();  // (joinVoice has opened the microphone by now)
  } else {
    sendToServer({ type: "call_cancel", channel });  // we couldn't get in: stop their ringing
    setOutgoingCall(null);
  }
});

// A two-tone ring, generated like the notification ping (it uses the same AudioContext).
function playRingtone() {
  if (isMuted() || notificationVolume <= 0) return;
  try {
    const peak = 0.12 * (notificationVolume / 100);
    // [when, pitch]: two short "ring-ring"s.
    for (const [start, pitch] of [[0, 660], [0.25, 880], [0.6, 660], [0.85, 880]]) {
      playTone(pitch, start, 0.22, peak);
    }
  } catch {}
}

// While our own call rings: a calm, nearly constant "duu-duu" (every 1.2 s), lower than the ringtone for an
// incoming call, so the two are easy to tell apart. It follows the notification volume, but not
// "do not disturb": we started this call ourselves.
let callingTimer = null;

function playCallingSound() {
  if (notificationVolume <= 0) return;
  try {
    const peak = 0.08 * (notificationVolume / 100);
    playTone(440, 0, 0.55, peak);     // A4
    playTone(523, 0.55, 0.55, peak);  // then C5
  } catch {}
}

// Short cues when you (or the other person in a call) come or go: "join" rises C5 → G5,
// "leave" falls G5 → C5. Like the other sounds: generated, following the notification volume.
function playVoiceCue(kind) {
  if (notificationVolume <= 0) return;
  try {
    const peak = 0.1 * (notificationVolume / 100);
    const pitches = kind === "join" ? [523, 784] : [784, 523];
    pitches.forEach((pitch, index) => playTone(pitch, index * 0.12, 0.18, peak));  // 0.12 s apart
  } catch {}
}

// Every change to outgoingCall goes through here, so however a ringing call ends (answered,
// declined, no answer, hung up), the calling sound stops with it.
function setOutgoingCall(channel) {
  outgoingCall = channel;
  clearInterval(callingTimer);
  callingTimer = null;
}

// The calling sound starts only once we're connected and the microphone is open: opening the
// microphone makes Windows reconfigure the sound device, which would put a tick in a sound
// that's already playing.
function startCallingSound() {
  clearInterval(callingTimer);
  playCallingSound();
  callingTimer = setInterval(playCallingSound, 1200);
}

function startRinging(call) {
  if (incomingCall && incomingCall.channel === call.channel) return;  // already ringing
  // We're calling them (or already in that DM's call) too: no need to ring, just answer. This is
  // what happens when you both press Call at the same moment.
  if (voiceRoomName === call.channel) {
    sendToServer({ type: "call_answer", channel: call.channel, accept: true });
    return;
  }
  incomingCall = call;
  incomingCallName.textContent = call.name;
  incomingCallAvatar.replaceChildren(makeAvatar(call.from, call.name, "large"));
  // showModal(): on the browser's top layer, above any other popup that's open (Settings, a
  // profile...), which would otherwise cover it and make Accept unclickable.
  incomingCallDialog.showModal();
  playRingtone();
  ringTimer = setInterval(playRingtone, 2000);
  // Not looking at the chat: a desktop notification too (clicking it brings the window forward).
  if (!isLooking() && desktopNotifications && !isMuted() && "Notification" in window &&
      Notification.permission === "granted") {
    try {
      const avatar = people.get(call.from)?.avatar;
      callNotification = new Notification(call.name, {
        body: "📞 is calling you",
        icon: avatar ? "/avatars/" + encodeURIComponent(avatar) : undefined,
        tag: "call-" + call.channel,
      });
      callNotification.addEventListener("click", () => window.focus());
    } catch {}
  }
}

function stopRinging() {
  incomingCall = null;
  incomingCallDialog.close();
  clearInterval(ringTimer);
  if (callNotification) callNotification.close();
  callNotification = null;
}

callAcceptButton.addEventListener("click", () => {
  const call = incomingCall;
  if (!call) return;
  stopRinging();
  sendToServer({ type: "call_answer", channel: call.channel, accept: true });
  switchChannel(call.channel, channelLabel(call.channel));
  joinVoice(call.channel, channelLabel(call.channel));  // (leaves Lounge or another call first)
});

// Esc closes a modal dialog by itself (its "cancel" event): not this one, only Accept or Decline.
incomingCallDialog.addEventListener("cancel", (event) => event.preventDefault());

callDeclineButton.addEventListener("click", () => {
  const call = incomingCall;
  if (!call) return;
  stopRinging();
  sendToServer({ type: "call_answer", channel: call.channel, accept: false });
});

// A short message in the voice bar after a call ends without an answer, gone after 4 seconds.
function showCallNotice(channel, text) {
  if (voiceRoom) return;  // in another room: don't cover its bar
  voiceBar.hidden = false;
  voiceWhere.textContent = channelLabel(channel);
  setVoiceStatus(text, "error");
  setTimeout(() => {
    if (!voiceRoom) voiceBar.hidden = true;
  }, 4000);
}

// The server's call messages (from handleServerMessage).
function handleCallMessage(data) {
  if (data.type === "call") {
    startRinging(data);
  } else if (data.type === "call_answered") {
    if (incomingCall && incomingCall.channel === data.channel) stopRinging();  // answered on another device
    if (outgoingCall === data.channel) {
      setOutgoingCall(null);
      // (Still connecting? Then voiceRoom may not exist yet: joinVoice shows "Voice connected" when done.)
      if (voiceRoomName === data.channel && voiceRoom && voiceRoom.state === "connected") {
        setVoiceStatus("Voice connected");
      }
    }
  } else if (data.type === "call_ended") {
    if (incomingCall && incomingCall.channel === data.channel) stopRinging();
    if (outgoingCall === data.channel) {
      setOutgoingCall(null);
      leaveVoice();  // nobody answered: hang up
      showCallNotice(data.channel, data.reason === "declined" ? "Declined" : "No answer");
    }
  }
}

// ----- The Lounge page: a tile for everyone in Lounge (their camera, or their picture), and the
// voice buttons (or "Join Lounge" when we're not in it).

const loungeView = document.getElementById("lounge-view");
const loungeTiles = document.getElementById("lounge-tiles");
const loungeMute = document.getElementById("lounge-mute");
const loungeCamera = document.getElementById("lounge-camera");
const loungeLeave = document.getElementById("lounge-leave");
const loungeJoin = document.getElementById("lounge-join");
const loungeFullscreen = document.getElementById("lounge-fullscreen");

function renderLoungeView() {
  if (currentChannel !== LOUNGE) return;  // not looking at it: nothing to draw
  const inLounge = voiceRoomName === "lounge";
  const members = voiceMembers.lounge || [];  // from the server, the same list as in the sidebar
  if (members.length === 0) {
    const empty = document.createElement("p");
    empty.className = "lounge-empty";
    empty.textContent = "Nobody's in Lounge right now.";
    loungeTiles.replaceChildren(empty);
    loungeTiles.classList.remove("focused");
    focusedTile["lounge-tiles"] = null;
  } else {
    // Shared screens first (only visible to those in Lounge, like cameras), then everyone.
    const screens = inLounge ? members.filter(({ id }) => screenTrack(id)).map(({ id }) => makeScreenTile(id)) : [];
    showTiles(loungeTiles, [
      ...screens,
      ...members.map(({ id, muted }) => makeTile(id, { muted, video: inLounge ? cameraTrack(id) : null })),
    ]);
  }
  loungeFullscreen.hidden = !inLounge;
  loungeMute.hidden = !inLounge;
  loungeCamera.hidden = !inLounge;
  loungeShare.hidden = !inLounge || !canShareScreen;
  loungeLeave.hidden = !inLounge;
  loungeJoin.hidden = inLounge;
  loungeMute.classList.toggle("off", micMuted);
  loungeMute.title = micMuted ? "Unmute" : "Mute";
  loungeMute.setAttribute("aria-label", loungeMute.title);
  showSpeaking();  // the rings
}

// One person's tile, on the Lounge page and in the DM call banner: their camera filling it
// (`video`, a track, or null), or their picture in the middle; their name in the corner.
// `away`: not in the call (yet), so the picture is faded; `note` replaces the name ("Calling…").
// Click: focus it (or back to the grid); right-click: their profile (and volume).
function makeTile(id, { muted = false, video = null, away = false, note = "" } = {}) {
  const name = people.has(id) ? people.get(id).name : "?";
  const tile = document.createElement("div");
  tile.className = away ? "call-tile away" : "call-tile";
  tile.dataset.userId = id;  // (for the speaking ring)
  tile.dataset.key = "user:" + id;  // (which tile is focused, see showTiles)
  tile.append(video ? videoFor(video, id === myId) : makeAvatar(id, name, "large"));
  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = note || (muted ? "🔇 " + name : name);
  tile.append(label);
  tile.addEventListener("click", () => toggleFocus(tile));
  // "contextmenu": a right-click. preventDefault: no browser menu on top of the profile.
  tile.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openProfile(id);
  });
  return tile;
}

// A shared screen's tile: the screen fitted inside, "Axel's screen" in the corner.
// (On the Lounge page it takes the whole width.)
function makeScreenTile(id) {
  const name = people.has(id) ? people.get(id).name : "?";
  const tile = document.createElement("div");
  tile.className = "call-tile screen-tile";
  tile.dataset.key = "screen:" + id;
  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = id === myId ? "Your screen" : name + "'s screen";
  tile.append(screenVideo(screenTrack(id), "tile-video screen"), label);
  tile.addEventListener("click", () => toggleFocus(tile));
  return tile;
}

// ----- Focus: one tile big ("the stage"), the others as small thumbnails in a row below it
// ("the strip"). The tiles are made anew every time something changes (a mute, a camera), so
// what's focused is kept as the tile's key ("user:5", "screen:5"), one for each place.
const focusedTile = { "call-tiles": null, "lounge-tiles": null };

// Put these tiles in `area` (the banner's or Lounge's): as a grid, or with the focused one on
// the stage. If the focused one is gone (they left, stopped sharing), back to the grid.
function showTiles(area, tiles) {
  const focused = tiles.find((tile) => tile.dataset.key === focusedTile[area.id]);
  area.classList.toggle("focused", Boolean(focused));
  if (!focused) {
    focusedTile[area.id] = null;
    area.replaceChildren(...tiles);
    fitTiles(area);
    return;
  }
  const stage = document.createElement("div");
  stage.className = "tile-stage";
  stage.append(focused);
  const others = tiles.filter((tile) => tile !== focused);
  const strip = document.createElement("div");
  strip.className = "tile-strip";
  strip.append(...others);
  area.replaceChildren(stage, ...(others.length > 0 ? [strip] : []));
  fitTiles(stage);  // one tile, as big as the stage allows
}

// A tile was clicked: focus it, or, if it's the focused one, back to the grid. Then draw again.
function toggleFocus(tile) {
  const area = tile.closest("#call-tiles, #lounge-tiles");  // the nearest of these around it
  focusedTile[area.id] = focusedTile[area.id] === tile.dataset.key ? null : tile.dataset.key;
  if (area === callTiles) renderCallPanel();
  else renderLoungeView();
}

// ----- Fullscreen: the whole banner (or Lounge page), tiles and buttons. Esc leaves too.
function toggleFullscreen(element) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else element.requestFullscreen().catch(() => {});
}
callPanelFullscreen.addEventListener("click", () => toggleFullscreen(callPanel));
loungeFullscreen.addEventListener("click", () => toggleFullscreen(loungeView));

// Into or out of fullscreen (by the button, Esc, ...): the buttons say which it'll do next.
document.addEventListener("fullscreenchange", () => {
  for (const button of document.querySelectorAll(".fullscreen-button")) {
    button.title = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
    button.setAttribute("aria-label", button.title);
  }
});

// Make the tiles in `area` as big as possible while they all fit inside it, at 16:9. Try every
// number of columns: with that many, how wide can a tile be before the tiles get wider than the
// area, or (in rows) taller than it? Keep the biggest. A wide area puts them side by side, a tall
// one stacks them. The result goes into the CSS variable --tile-width, which the tiles use.
const TILE_GAP = 8;  // the space between tiles, the same as "gap" in the CSS

function fitTiles(area) {
  const count = area.querySelectorAll(".call-tile").length;
  const width = area.clientWidth;
  const height = area.clientHeight;
  let best = 0;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const byWidth = (width - (columns - 1) * TILE_GAP) / columns;
    const byHeight = ((height - (rows - 1) * TILE_GAP) / rows) * 16 / 9;  // a row's height, as a 16:9 width
    best = Math.max(best, Math.min(byWidth, byHeight));
  }
  area.style.setProperty("--tile-width", Math.floor(best) + "px");
}

// Fit again whenever a tile area changes size: the window resized, the banner shown or dragged,
// fullscreen. With a focused tile, it's the stage that's fitted. (A ResizeObserver calls its
// function, with a list of what changed, when a watched element's size changes.)
const tileResizeObserver = new ResizeObserver((entries) => {
  for (const { target: area } of entries) {
    fitTiles(area.querySelector(":scope > .tile-stage") || area);  // ":scope >": directly inside
  }
});
tileResizeObserver.observe(callTiles);
tileResizeObserver.observe(loungeTiles);

// ----- Resizing the banner: drag the bar on its bottom edge. Pointer events, like dragging a
// picture in the editor: remember where the drag started and how tall the banner was, then on
// every move set the height to that plus how far the pointer moved. The tiles follow by
// themselves (the ResizeObserver above). The height is kept in this browser for next time.

const callResize = document.getElementById("call-resize");
const MIN_CALL_HEIGHT = 160;   // the same as min-height in the CSS
const MIN_MESSAGES_HEIGHT = 100;  // the banner may take the messages' space, but leaves this much
let resizeFrom = null;  // while dragging: {y, height} at the start

try {
  const saved = Number(localStorage.getItem("callPanelHeight"));
  if (saved > 0) callPanel.style.height = saved + "px";  // (none saved: the CSS's 40% of the window)
} catch {}

callResize.addEventListener("pointerdown", (event) => {
  callResize.setPointerCapture(event.pointerId);  // keep getting the moves, even off the bar
  callResize.classList.add("dragging");
  resizeFrom = { y: event.clientY, height: callPanel.offsetHeight };
});

callResize.addEventListener("pointermove", (event) => {
  if (!resizeFrom) return;
  // As tall as it is plus all of the messages' height, minus what the messages must keep.
  const max = callPanel.offsetHeight + messages.clientHeight - MIN_MESSAGES_HEIGHT;
  const height = resizeFrom.height + (event.clientY - resizeFrom.y);  // down: taller
  callPanel.style.height = Math.round(Math.max(MIN_CALL_HEIGHT, Math.min(max, height))) + "px";
});

function stopResizing() {
  if (!resizeFrom) return;
  resizeFrom = null;
  callResize.classList.remove("dragging");
  try {
    localStorage.setItem("callPanelHeight", String(callPanel.offsetHeight));
  } catch {}
}
callResize.addEventListener("pointerup", stopResizing);
callResize.addEventListener("pointercancel", stopResizing);  // e.g. the phone took over the touch

loungeMute.addEventListener("click", () => voiceMuteButton.click());  // the same as the voice bar's
loungeCamera.addEventListener("click", toggleCamera);
loungeLeave.addEventListener("click", leaveVoice);
loungeJoin.addEventListener("click", () => joinVoice("lounge", "Lounge"));
