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

// After a change to mute or deafen: every button that shows it, and everyone else's view of us.
function showMuteButton() {
  renderUserPanel();  // the 🎤 and 🎧 at the bottom left (people.js)
  sendVoiceState();  // the 🔇 or 🎧 next to our name
  renderCallPanel();  // ...and in the call banner (and on the Lounge page)
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
    // Paused since the last call or test (voice.js, closeMicIfUnused). Not waited for: without a
    // tap on the page yet, the browser only starts it later ("Tap here to turn on sound").
    context.resume().catch(() => {});
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
    watchSpeaking();  // the speaking rings (voice.js)

    // Someone else's audio has reached us: track.attach() starts playing it. Their camera: the
    // call banner shows it (renderCallPanel attaches it to a <video> there).
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === "video") {
        renderCallPanel();
        return;
      }
      voiceAudio.appendChild(track.attach());
      applyVolume(participant);
      // Their voice (not a shared screen's sound): measure it for their speaking ring (voice.js).
      if (publication.source === LivekitClient.Track.Source.Microphone) {
        listenForSpeaking(participant.identity, track, context);
      }
      // A shared screen's sound: its tile gets a volume slider.
      if (publication.source === LivekitClient.Track.Source.ScreenShareAudio) renderCallPanel();
    });
    // ...and when they leave or stop sending, stop it again.
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      for (const element of track.detach()) element.remove();
      if (publication.source === LivekitClient.Track.Source.Microphone) stopListeningForSpeaking(participant.identity);
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
        stopAppAudio();  // (its sound from the Windows app, if any)
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
      if (roomName !== "lounge") playVoiceCue("join");
    });
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => {
      renderCallPanel();
      if (roomName !== "lounge") playVoiceCue("leave");
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
    voiceServer = new URL(answer.url).host;  // "wss://voice.example.com" -> "voice.example.com" (voice.js)
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
    } catch (error) {
      if (voiceRoom === room) showNoMicrophone(error);
    }
  }
  if (voiceRoom === room) startConnectionStats();  // the signal icon and its popup (voice.js)
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
  stopAppAudio();
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
  stopConnectionStats();
  markVoiceChannel();
  voiceAnalysers.clear();  // (voice.js: the speaking rings)
  lastHeard.clear();
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
    const label = button.textContent.trim();  // (its icon is a drawing, not text)
    switchChannel(button.dataset.channel, label);
    if (voiceRoomName !== button.dataset.room) joinVoice(button.dataset.room, label);
  });
}

voiceLeaveButton.addEventListener("click", leaveVoice);

// Mute or unmute. Works outside voice too (then it counts from the next time we join).
async function setMicMuted(muted) {
  micMuted = muted;
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
  } catch (error) {
    if (voiceRoom === room) showNoMicrophone(error);
  }
}

// The 🎤 buttons (bottom left, call banner, Lounge page). Unmuting while deafened undeafens too,
// like Discord: you can't talk without hearing.
function toggleMute() {
  if (deafened) {
    deafened = false;
    applyAllVolumes();
    setMicMuted(false);
    return;
  }
  setMicMuted(!micMuted);
}

// The 🎧 button: hear nobody, and be muted while at it. Undeafening puts the mute back to what it
// was before, so someone who was muted already stays muted.
function toggleDeafen() {
  deafened = !deafened;
  applyAllVolumes();
  if (deafened) {
    mutedBeforeDeafen = micMuted;
    setMicMuted(true);
  } else {
    setMicMuted(mutedBeforeDeafen);
  }
}

// Everyone's volume again (after deafening: 0, after undeafening: back to what it was).
function applyAllVolumes() {
  if (!voiceRoom) return;
  for (const participant of voiceRoom.remoteParticipants.values()) applyVolume(participant);
}

// Clicking the status ("Voice connected"): the connection details, like the signal icon. Except
// in the "Tap here to turn on sound" case: that click lets the browser play the others' audio.
voiceStatus.addEventListener("click", async () => {
  if (!voiceRoom) return;
  if (!voiceStatus.classList.contains("clickable")) {
    openConnectionStats();
    return;
  }
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
const muteButton = document.getElementById("mute-button");
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
  const inGroup = isGroup(channel) && groups.has(channel);
  const members = dmCalls[channel] || [];
  const inCall = (partner !== null || inGroup) && voiceRoomName === channel;
  // Only in a DM or group, and only while someone is in its call.
  callPanel.hidden = (partner === null && !inGroup) || (!inCall && members.length === 0);
  if (callPanel.hidden) {
    if (document.fullscreenElement === callPanel) document.exitFullscreen().catch(() => {});  // the call ended
    return;
  }
  if (inGroup) {
    renderGroupCallTiles(members, inCall);
  } else {
    renderDmCallTiles(partner, members, inCall);
  }
  callPanelFullscreen.hidden = !inCall;
  callPanelMute.hidden = !inCall;
  callPanelCamera.hidden = !inCall;
  callPanelShare.hidden = !inCall || !canShareScreen;
  callPanelEnd.hidden = !inCall;
  callPanelJoin.hidden = inCall;
  callPanelMute.classList.toggle("off", micMuted);
  setIcon(callPanelMute, micMuted ? "mic-off" : "mic");
  callPanelMute.title = micMuted ? "Unmute" : "Mute";
  callPanelMute.setAttribute("aria-label", callPanelMute.title);
  showSpeaking();  // the rings
}

// A group's call: like the Lounge page, a tile for everyone in it (from the server's list), and
// us first, faded while we're not in it. Shared screens before them, while we're in it ourselves.
function renderGroupCallTiles(members, inCall) {
  const others = members.filter(({ id }) => id !== myId);
  const screens = inCall
    ? [myId, ...others.map(({ id }) => id)].filter((id) => screenTrack(id)).map(makeScreenTile)
    : [];
  showTiles(callTiles, [
    ...screens,
    makeTile(myId, { muted: inCall && micMuted, deafened: inCall && deafened, video: inCall ? cameraTrack(myId) : null, away: !inCall }),
    ...others.map(({ id, muted, deafened }) => makeTile(id, { muted, deafened, video: inCall ? cameraTrack(id) : null })),
  ]);
}

// A DM's call: us (faded while we're not in it), and the other person while they're in it or
// while it rings for them ("Calling…"). Someone who hung up has no tile (the user's wish).
function renderDmCallTiles(partner, members, inCall) {
  const channel = currentChannel;
  const partnerMember = members.find((member) => member.id === partner);
  // In the call ourselves, LiveKit knows best whether they're there; otherwise, the server.
  const partnerHere = inCall
    ? Boolean(voiceRoom && voiceRoom.remoteParticipants.has(String(partner)))
    : Boolean(partnerMember);
  const ringing = outgoingCall === channel;
  // Shared screens first (ours too, so we see what they see; only while we're in the call),
  // then us, then them (faded with "Calling…" while it rings).
  const screens = inCall ? [myId, partner].filter((id) => screenTrack(id)).map(makeScreenTile) : [];
  const tiles = [
    ...screens,
    makeTile(myId, { muted: inCall && micMuted, deafened: inCall && deafened, video: inCall ? cameraTrack(myId) : null, away: !inCall }),
  ];
  if (partnerHere || ringing) {
    tiles.push(makeTile(partner, {
      muted: partnerHere && Boolean(partnerMember && partnerMember.muted),
      deafened: partnerHere && Boolean(partnerMember && partnerMember.deafened),
      video: inCall && partnerHere ? cameraTrack(partner) : null,  // (only while we're in the call too)
      away: !partnerHere,
      note: !partnerHere ? "Calling…" : "",
    }));
  }
  showTiles(callTiles, tiles);
}

callPanelMute.addEventListener("click", toggleMute);  // the same as the 🎤 at the bottom left
callPanelCamera.addEventListener("click", toggleCamera);
callPanelEnd.addEventListener("click", leaveVoice);
callPanelJoin.addEventListener("click", () => joinVoice(currentChannel, channelLabel(currentChannel)));

// The bar at the top of every chat: its name and 📌 (the pinned messages, messages.js). In a DM
// also the call button ("In call" while we're in that DM's call); in a group DM its members, its
// buttons (people.js, showGroupHeader) and the call button.
function showDmHeader() {
  renderCallPanel();  // (the banner below it changes at the same moments)
  const inDm = dmPartner(currentChannel) !== null;
  showGroupHeader();
  const inGroup = !groupButtons.hidden;
  dmHeader.hidden = !inDm && !inGroup && !isChannel(currentChannel);
  if (dmHeader.hidden) return;
  dmHeaderName.textContent = channelLabel(currentChannel);
  // The name opens the chat info panel (chat-info.js), in DMs and groups only (the user's choice).
  dmHeaderName.disabled = !inDm && !inGroup;
  dmHeaderName.title = dmHeaderName.disabled ? "" : "Members, media, pins, links and files";
  // No calls in channels (that's what Lounge is for), nor with a bot (server.py's is_call_member says no).
  const withBot = people.get(dmPartner(currentChannel))?.bot === true;
  callButton.hidden = (!inDm && !inGroup) || withBot;
  // The bell mutes this chat, the crossed-out bell unmutes it. Not in a DM with an admin: admins can't be muted (server.py, can_mute).
  const muted = mutedChats.has(currentChannel);
  muteButton.hidden = !muted && people.get(dmPartner(currentChannel))?.admin === true;
  setIcon(muteButton, muted ? "bell-off" : "bell");
  muteButton.title = muted ? "Unmute this chat" : "Mute this chat";
  muteButton.setAttribute("aria-label", muteButton.title);
  muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
  const inThisCall = voiceRoomName === currentChannel;
  callButton.disabled = inThisCall;
  callButton.textContent = inThisCall ? "In call" : "Call";
  setIcon(callButton, "phone");
}

// Mute or unmute the chat we're in. The server answers all our pages with the new list ("mutes").
muteButton.addEventListener("click", () => {
  sendToServer({ type: "mute", channel: currentChannel, muted: !mutedChats.has(currentChannel) });
});

callButton.addEventListener("click", async () => {
  const channel = currentChannel;
  if (voiceRoom) leaveVoice();  // leave Lounge (or another call) first, so leaving doesn't hang up this one
  if ((dmCalls[channel] || []).length > 0) {
    joinVoice(channel, channelLabel(channel));  // a call is going on already: just join it, no ringing
    return;
  }
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
  // In a group: who's calling, and in which group ("kari · Weekend plans").
  incomingCallName.textContent = isGroup(call.channel) ? `${call.name} · ${groupLabel(call.channel)}` : call.name;
  incomingCallAvatar.replaceChildren(makeAvatar(call.from, call.name, "large"));
  // showModal(): on the browser's top layer, above any other popup that's open (Settings, a
  // profile...), which would otherwise cover it and make Accept unclickable.
  incomingCallDialog.showModal();
  playRingtone();
  ringTimer = setInterval(playRingtone, 2000);
  // Not looking at the chat: a desktop notification too (clicking it brings the window forward).
  // (Not on a device with push on: it gets the call as a push, sw.js.)
  if (!isLooking() && !pushOn && desktopNotifications && !isMuted() && "Notification" in window &&
      Notification.permission === "granted") {
    try {
      const avatar = people.get(call.from)?.avatar;
      const notification = new Notification(call.name, {
        body: "📞 is calling you",
        icon: avatar ? "/avatars/" + encodeURIComponent(avatar) : undefined,
        tag: "call-" + call.channel,
      });
      // In the desktop app, Notification is the notification plugin's stand-in: it shows the
      // notification, but what it gives back has no click event and no close() (a click brings
      // the window forward by itself, in main.rs). Only a browser's real one is kept, to close it.
      if (!inDesktopApp) {
        notification.addEventListener("click", () => window.focus());
        callNotification = notification;
      }
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
  renderCallFloat();  // (the floating call window changes at the same moments: see below)
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
      ...members.map(({ id, muted, deafened }) => makeTile(id, { muted, deafened, video: inLounge ? cameraTrack(id) : null })),
    ]);
  }
  loungeFullscreen.hidden = !inLounge;
  loungeMute.hidden = !inLounge;
  loungeCamera.hidden = !inLounge;
  loungeShare.hidden = !inLounge || !canShareScreen;
  loungeLeave.hidden = !inLounge;
  loungeJoin.hidden = inLounge;
  loungeMute.classList.toggle("off", micMuted);
  setIcon(loungeMute, micMuted ? "mic-off" : "mic");
  loungeMute.title = micMuted ? "Unmute" : "Mute";
  loungeMute.setAttribute("aria-label", loungeMute.title);
  showSpeaking();  // the rings
}

// One person's tile, on the Lounge page and in the DM call banner: their camera filling it
// (`video`, a track, or null), or their picture in the middle; their name in the corner.
// `away`: not in the call (yet), so the picture is faded; `note` replaces the name ("Calling…").
// Click: focus it (or back to the grid); right-click: their profile (and volume).
function makeTile(id, { muted = false, deafened = false, video = null, away = false, note = "" } = {}) {
  const name = people.has(id) ? people.get(id).name : "?";
  const tile = document.createElement("div");
  tile.className = away ? "call-tile away" : "call-tile";
  tile.dataset.userId = id;  // (for the speaking ring)
  tile.dataset.key = "user:" + id;  // (which tile is focused, see showTiles)
  tile.append(video ? videoFor(video, id === myId) : makeAvatar(id, name, "large"));
  const label = document.createElement("span");
  label.className = "tile-name";
  // "Calling…", or the name with 🔇 or a crossed-out 🎧 in front (voice.js, makeVoiceStateIcon).
  const icon = note ? null : makeVoiceStateIcon({ muted, deafened });
  if (icon) label.append(icon, " ");
  label.append(note || name);  // (append adds text as plain text, like textContent)
  tile.append(label);
  tile.addEventListener("click", () => toggleFocus(tile));
  tile.dataset.userMenu = id;  // right-click: the user menu, with Profile first (people.js)
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
  tile.append(videoFor(screenTrack(id), false, "tile-video screen"), label);
  if (screenHasSound(id)) tile.append(makeScreenVolume(id));
  tile.title = "Double-click for fullscreen";  // (handled by the tile areas, see "Fullscreen")
  tile.addEventListener("click", () => toggleFocus(tile));
  return tile;
}

// 🔊 and a slider in a shared screen's corner: how loud its sound is for us (voice.js,
// setScreenVolume). Shown while the mouse is over the screen (chat.css, .screen-volume).
function makeScreenVolume(id) {
  const box = document.createElement("label");  // (a label: its text belongs to the slider)
  box.className = "screen-volume";
  box.title = "This screen's volume";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "200";
  slider.step = "5";
  slider.value = screenVolume(id);
  slider.setAttribute("aria-label", "Screen volume");
  const value = document.createElement("span");
  value.className = "slider-value";
  value.textContent = slider.value + "%";
  // "input": while it's being dragged, not only when let go.
  slider.addEventListener("input", () => {
    setScreenVolume(id, Number(slider.value));
    value.textContent = slider.value + "%";
  });
  box.append(makeIcon("volume-2"), slider, value);
  // Clicks and drags here are for the slider: stop them from going on up ("bubbling") to the
  // tile (focus) and its area (double-click for fullscreen).
  for (const type of ["click", "dblclick", "pointerdown"]) {
    box.addEventListener(type, (event) => event.stopPropagation());
  }
  return box;
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
  makeStripMovable(strip);  // (only in fullscreen, where it's a mini window)
  area.replaceChildren(stage, ...(others.length > 0 ? [strip] : []));
  fitTiles(stage);  // one tile, as big as the stage allows
}

// The tile clicked last, for a double-click (see "Fullscreen").
let lastClickedKey = null;

// A tile was clicked: focus it, or, if it's the focused one, back to the grid. Then draw again.
function toggleFocus(tile) {
  const area = tile.closest("#call-tiles, #lounge-tiles");  // the nearest of these around it
  lastClickedKey = tile.dataset.key;
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

// Double-clicking a shared screen: the same fullscreen, with that screen focused. (Not just the
// <video>: then nobody else and none of the buttons would show.) The two clicks before a
// double-click each redraw the tiles, so the tile under the pointer may be a different one by
// now: the first click's tile is the one meant. The areas themselves are never redrawn, so they
// listen, and get the event from whatever is under the pointer ("bubbling").
for (const [area, element] of [[callTiles, callPanel], [loungeTiles, loungeView]]) {
  area.addEventListener("dblclick", () => {
    if (!lastClickedKey || !lastClickedKey.startsWith("screen:")) return;
    focusedTile[area.id] = lastClickedKey;
    if (area === callTiles) renderCallPanel();
    else renderLoungeView();
    toggleFullscreen(element);
  });
}

// ----- The mini window: in fullscreen, the strip of thumbnails floats over the stage (chat.css,
// ":fullscreen .tile-strip") in one of four corners. Drag it anywhere, and when let go it snaps
// to the nearest corner, which is kept for next time (voiceSettings.miniCorner).
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const DRAG_THRESHOLD = 5;  // pixels the pointer must move before it's a drag, not a click

// Put the strip in this corner: one of the four "corner-..." classes on, the others off.
function placeStrip(strip, corner) {
  for (const name of CORNERS) strip.classList.toggle("corner-" + name, name === corner);
}

// Pointer events, like resizing the banner below. A strip is made anew with every redraw, and
// these listeners (and `start`, `dragged`) go with it.
function makeStripMovable(strip) {
  placeStrip(strip, voiceSettings.miniCorner);
  let start = null;      // while the button is held: where the pointer went down
  let dragged = false;   // did it move far enough to be a drag?
  strip.addEventListener("pointerdown", (event) => {
    if (!document.fullscreenElement || event.button !== 0) return;  // left button only
    start = { x: event.clientX, y: event.clientY };
    dragged = false;
  });
  strip.addEventListener("pointermove", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dragged) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;  // (hypot: the straight-line distance)
      dragged = true;
      // Only now: catching the pointer from the start would take the click away from the tiles.
      strip.setPointerCapture(event.pointerId);
      strip.classList.add("dragging");
    }
    strip.style.transform = `translate(${dx}px, ${dy}px)`;  // follow the pointer
  });
  const letGo = () => {
    if (dragged) snapStrip(strip);
    start = null;
  };
  // Pressing on a picture and moving starts the browser's own drag-and-drop (dragging the image
  // out of the page), which takes the pointer away from us: not here.
  strip.addEventListener("dragstart", (event) => event.preventDefault());
  strip.addEventListener("pointerup", letGo);
  strip.addEventListener("pointercancel", letGo);  // (the browser took the pointer, e.g. a gesture)
  // Letting go also counts as a click: after a drag, it mustn't reach a tile and focus it.
  // "true": this listener runs on the way down to the tile ("capture"), before the tile's own.
  strip.addEventListener("click", (event) => {
    if (dragged) event.stopPropagation();
  }, true);
}

// 👥 (shown only in fullscreen, by the CSS): hide or show the mini window. A class on <body>
// does it ("mini-hidden", see chat.css), so the strips made by later redraws follow it too.
const miniButtons = document.querySelectorAll(".mini-button");

function showMiniWindow() {
  document.body.classList.toggle("mini-hidden", voiceSettings.miniHidden);
  for (const button of miniButtons) {
    button.classList.toggle("on", !voiceSettings.miniHidden);  // highlighted while it's shown
    button.title = voiceSettings.miniHidden ? "Show participants" : "Hide participants";
    button.setAttribute("aria-label", button.title);
  }
}
for (const button of miniButtons) {
  button.addEventListener("click", () => {
    voiceSettings.miniHidden = !voiceSettings.miniHidden;
    saveVoiceSettings();
    showMiniWindow();
  });
}
showMiniWindow();

// Let go: which half of the area is the strip's middle in, across and down? That's its corner.
// Then glide there ("FLIP"): move it to the new corner, shift it back to where it was let go,
// and let a CSS transition take the shift away.
function snapStrip(strip) {
  const before = strip.getBoundingClientRect();
  const area = strip.parentElement.getBoundingClientRect();
  const vertical = before.top + before.height / 2 < area.top + area.height / 2 ? "top" : "bottom";
  const horizontal = before.left + before.width / 2 < area.left + area.width / 2 ? "left" : "right";
  voiceSettings.miniCorner = vertical + "-" + horizontal;
  saveVoiceSettings();
  strip.classList.remove("dragging");
  placeStrip(strip, voiceSettings.miniCorner);
  strip.style.transform = "";
  const after = strip.getBoundingClientRect();
  strip.style.transform = `translate(${before.left - after.left}px, ${before.top - after.top}px)`;
  // Reading a size makes the browser apply the shift now, so the transition starts from it.
  strip.offsetWidth;
  strip.classList.add("snapping");
  strip.style.transform = "";
  strip.addEventListener("transitionend", () => strip.classList.remove("snapping"), { once: true });
}

// Into or out of fullscreen (by the button, Esc, ...): the buttons say which it'll do next.
document.addEventListener("fullscreenchange", () => {
  for (const button of document.querySelectorAll(".fullscreen-button")) {
    button.title = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
    setIcon(button, document.fullscreenElement ? "minimize" : "maximize");
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

loungeMute.addEventListener("click", toggleMute);  // the same as the 🎤 at the bottom left
loungeCamera.addEventListener("click", toggleCamera);
loungeLeave.addEventListener("click", leaveVoice);
loungeJoin.addEventListener("click", () => joinVoice("lounge", "Lounge"));

// ---------- The floating call window ----------
//
// In a call but looking at something else (another chat, the People page, a DM while in Lounge):
// whoever is talking, as a small tile in a corner (their camera if it's on), so the call never goes
// out of sight; like Discord's on phones. A click goes back to the call. Drag it anywhere: let go and
// it slides into the nearest corner of the chat area, and stays there (localStorage "callFloatCorner").
// The tile is makeTile's, so it has the speaking ring, the mute icons and the user menu (right-click).

const callFloat = document.getElementById("call-float");
const FLOAT_MARGIN = 16;  // from the chat area's edges
let floatCorner = "bottom-right";  // "top-left", "top-right", "bottom-left" or "bottom-right"
try {
  floatCorner = localStorage.getItem("callFloatCorner") || floatCorner;
} catch {}
let floatShownId = null;    // whose tile it shows now
let lastSpeakerId = null;   // the last other person who talked in our call

// The call's page: the Lounge page, or the DM or group the call is in. null: not in a call.
function callPage() {
  return voiceRoomName === "lounge" ? LOUNGE : voiceRoomName;
}

// Who it shows: whoever talked last (not us), else the DM's other person, else anyone else there, else us.
function floatPerson() {
  const others = voiceRoom ? [...voiceRoom.remoteParticipants.keys()].map(Number) : [];
  if (lastSpeakerId !== null && others.includes(lastSpeakerId)) return lastSpeakerId;
  const partner = dmPartner(voiceRoomName);
  if (partner !== null) return partner;
  return others[0] ?? myId;
}

// Called whenever a call or the page we're on changes (renderLoungeView, which every such change reaches).
function renderCallFloat() {
  const page = callPage();
  if (page === null) lastSpeakerId = null;
  const show = page !== null && currentChannel !== page;
  callFloat.hidden = !show;
  if (!show) {
    floatShownId = null;
    return;
  }
  const id = floatPerson();
  const members = (voiceRoomName === "lounge" ? voiceMembers.lounge : dmCalls[voiceRoomName]) || [];
  const state = members.find((member) => member.id === id) || {};
  const here = id === myId || voiceRoom?.remoteParticipants.has(String(id));
  const ringing = outgoingCall === voiceRoomName && !here;
  const tile = makeTile(id, {
    muted: state.muted, deafened: state.deafened, video: here ? cameraTrack(id) : null, away: !here,
    note: ringing ? "Calling…" : "",
  });
  tile.classList.toggle("speaking", speakingIds.has(String(id)));
  callFloat.replaceChildren(tile);
  floatShownId = id;
  placeFloat();
}

// The area it sits in: the messages (in a chat), else the page that's showing.
function floatArea() {
  if (!channelView.hidden) return messages.getBoundingClientRect();
  return (friendsView.hidden ? loungeView : friendsView).getBoundingClientRect();
}

function placeFloat() {
  if (callFloat.hidden) return;
  const area = floatArea();
  const [vertical, horizontal] = floatCorner.split("-");
  const left = horizontal === "left" ? area.left + FLOAT_MARGIN : area.right - callFloat.offsetWidth - FLOAT_MARGIN;
  const top = vertical === "top" ? area.top + FLOAT_MARGIN : area.bottom - callFloat.offsetHeight - FLOAT_MARGIN;
  callFloat.style.left = Math.max(0, left) + "px";
  callFloat.style.top = Math.max(0, top) + "px";
}

addEventListener("resize", placeFloat);

// Dragging, with pointer events (mouse and fingers alike). setPointerCapture keeps the moves coming to
// it even when the pointer is quicker than the window. A press that moves less than 5 px is a click.
let floatDrag = null;  // {x, y, left, top, moved} while pressed
let floatJustDragged = false;

callFloat.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const box = callFloat.getBoundingClientRect();
  floatDrag = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, moved: false };
  callFloat.setPointerCapture(event.pointerId);
  callFloat.classList.remove("snapping");
});

callFloat.addEventListener("pointermove", (event) => {
  if (!floatDrag) return;
  const dx = event.clientX - floatDrag.x;
  const dy = event.clientY - floatDrag.y;
  if (!floatDrag.moved && Math.hypot(dx, dy) < 5) return;
  floatDrag.moved = true;
  callFloat.classList.add("dragging");
  callFloat.style.left = floatDrag.left + dx + "px";
  callFloat.style.top = floatDrag.top + dy + "px";
});

function endFloatDrag() {
  if (!floatDrag) return;
  const moved = floatDrag.moved;
  floatDrag = null;
  callFloat.classList.remove("dragging");
  if (!moved) return;  // a click: see below
  floatJustDragged = true;
  // The nearest corner: which half of the area its middle ended up in, across and down.
  const area = floatArea();
  const box = callFloat.getBoundingClientRect();
  const vertical = box.top + box.height / 2 < area.top + area.height / 2 ? "top" : "bottom";
  const horizontal = box.left + box.width / 2 < area.left + area.width / 2 ? "left" : "right";
  floatCorner = `${vertical}-${horizontal}`;
  try {
    localStorage.setItem("callFloatCorner", floatCorner);
  } catch {}
  callFloat.classList.add("snapping");  // (chat.css: left and top slide there)
  placeFloat();
}

callFloat.addEventListener("pointerup", endFloatDrag);
callFloat.addEventListener("pointercancel", endFloatDrag);

// A click (not the end of a drag) opens the call. In the capture phase, before the tile's own click
// handler (toggleFocus, for tiles in a call area), which mustn't run here.
callFloat.addEventListener("click", (event) => {
  event.stopPropagation();
  if (floatJustDragged) {
    floatJustDragged = false;
    return;
  }
  const page = callPage();
  if (page) switchChannel(page, channelLabel(page));
}, true);
