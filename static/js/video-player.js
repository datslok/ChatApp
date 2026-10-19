// The video player: our own control bar over a <video> (chat videos and the picture viewer's), instead
// of the browser's. The browser's bar can't be added to, and in a video as narrow as ours often are,
// Chromium hid its fullscreen button in its ⋮ menu. Like the phone app's (mobile/src/VideoScreen.js):
// the time bar on top; ▶/⏸, the time, the sound, its volume and fullscreen under it.
//
// A <video> without `controls` shows only the picture; everything the bar does goes through the video's
// own functions and properties (play(), pause(), currentTime, duration, volume, muted), and the bar
// redraws itself from the video's events (play, pause, timeupdate, volumechange, ...).
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html: before viewer.js
// and messages.js, which both use makeVideoPlayer.

const PLAYER_IDLE_MS = 2000;  // fullscreen: the bar and the mouse pointer hide after this long unmoved
const SKIP_SECONDS = 5;       // ← and → skip this far

// "1:05", or "1:02:03" for an hour or more (seconds as a number; not known yet: 0:00).
function videoTime(seconds) {
  const whole = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, "0");  // (padStart: 5 -> "05")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// A round-cornered icon button of the bar.
function makePlayerButton(icon, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "video-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(makeIcon(icon));
  return button;
}

// Puts `video` in a player (the frame with the bar over its bottom) and returns the frame. If the video
// is already on the page, the frame takes its place. arrowKeys: false leaves ← → to the page (the
// picture viewer goes through its pictures with them).
function makeVideoPlayer(video, { arrowKeys = true } = {}) {
  const frame = document.createElement("div");
  frame.className = "video-player paused";
  frame.tabIndex = 0;  // it can have the keyboard's focus (clicking it gives it), for the keys below
  if (video.parentNode) video.replaceWith(frame);
  video.controls = false;

  // The time bar: a slider from 0 to the video's length, in seconds. <input type="range"> is the
  // browser's own slider; "input" events come while it's being dragged.
  const timeBar = document.createElement("input");
  timeBar.type = "range";
  timeBar.className = "video-time-bar";
  timeBar.min = 0;
  timeBar.max = 0;
  timeBar.step = "any";  // (any value, not only whole seconds)
  timeBar.value = 0;
  timeBar.setAttribute("aria-label", "Time");

  const playButton = makePlayerButton("play", "Play");
  const time = document.createElement("span");
  time.className = "video-time";
  const spacer = document.createElement("span");
  spacer.className = "video-spacer";  // takes the free room, pushing the rest to the right
  const muteButton = makePlayerButton("volume-2", "Mute");
  const volume = document.createElement("input");
  volume.type = "range";
  volume.className = "video-volume";
  volume.min = 0;
  volume.max = 1;
  volume.step = 0.01;
  volume.setAttribute("aria-label", "Volume");
  const fullscreenButton = makePlayerButton("maximize", "Fullscreen");

  const row = document.createElement("div");
  row.className = "video-row";
  row.append(playButton, time, spacer, muteButton, volume, fullscreenButton);
  const bar = document.createElement("div");
  bar.className = "video-bar";
  bar.append(timeBar, row);
  frame.append(video, bar);

  // ----- What the bar shows, from the video's events
  function showTime() {
    timeBar.value = video.currentTime;
    time.textContent = `${videoTime(video.currentTime)} / ${videoTime(video.duration)}`;
  }
  function showPlaying() {
    const paused = video.paused;  // (also true once it has ended)
    frame.classList.toggle("paused", paused);  // paused in fullscreen: the bar doesn't hide (chat.css)
    setIcon(playButton, paused ? "play" : "pause");
    playButton.title = paused ? "Play" : "Pause";
    playButton.setAttribute("aria-label", playButton.title);
  }
  function showSound() {
    const silent = video.muted || video.volume === 0;
    volume.value = video.muted ? 0 : video.volume;
    setIcon(muteButton, silent ? "volume-x" : "volume-2");
    muteButton.title = silent ? "Unmute" : "Mute";
    muteButton.setAttribute("aria-label", muteButton.title);
  }
  // The length and shape are known (preload="metadata" loads them without the video itself).
  video.addEventListener("loadedmetadata", () => {
    timeBar.max = Number.isFinite(video.duration) ? video.duration : 0;
    // Taller than wide (a phone held upright): the player is at least square, the video in the
    // middle with black on both sides (chat.css, ".tall"), so it isn't a thin strip.
    frame.classList.toggle("tall", video.videoHeight > video.videoWidth);
    showTime();
  });
  video.addEventListener("durationchange", () => {
    timeBar.max = Number.isFinite(video.duration) ? video.duration : 0;
    showTime();
  });
  video.addEventListener("timeupdate", showTime);  // (several times a second while it plays)
  video.addEventListener("play", showPlaying);
  video.addEventListener("pause", showPlaying);
  video.addEventListener("ended", showPlaying);
  video.addEventListener("volumechange", showSound);
  // The viewer reuses one <video> for every video it shows: a new one starts from scratch.
  video.addEventListener("emptied", () => {
    timeBar.max = 0;
    frame.classList.remove("tall");
    showTime();
    showPlaying();
  });

  // ----- What the bar does
  // (play() at the end starts again from the beginning; .catch: a browser may refuse to start it, say
  // when the file is gone, and then there's nothing to do.)
  function playOrPause() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.3;  // (unmuting at no volume would still be silent)
    } else {
      video.muted = true;
    }
  }
  // The frame goes fullscreen, not the video, so our bar comes along. Esc comes out too.
  function toggleFullscreen() {
    if (document.fullscreenElement === frame) document.exitFullscreen().catch(() => {});
    else frame.requestFullscreen().catch(() => {});
  }
  playButton.addEventListener("click", playOrPause);
  muteButton.addEventListener("click", toggleMute);
  fullscreenButton.addEventListener("click", toggleFullscreen);
  video.addEventListener("click", playOrPause);         // a click on the picture: play or pause
  video.addEventListener("dblclick", toggleFullscreen);  // (its two clicks pause and play again: no change)
  timeBar.addEventListener("input", () => {
    video.currentTime = Number(timeBar.value);  // jump there while dragging, so the picture follows
    showTime();
  });
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  });

  // "fullscreenchange" comes to the element that went into or out of fullscreen.
  frame.addEventListener("fullscreenchange", () => {
    const full = document.fullscreenElement === frame;
    setIcon(fullscreenButton, full ? "minimize" : "maximize");
    fullscreenButton.title = full ? "Exit fullscreen" : "Fullscreen";
    fullscreenButton.setAttribute("aria-label", fullscreenButton.title);
  });

  // In fullscreen the bar would cover the film the whole time: it shows while the mouse moves (or a
  // finger touches), and hides PLAYER_IDLE_MS after it stopped ("awake", chat.css).
  let idleTimer = null;
  function wakeUp() {
    frame.classList.add("awake");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => frame.classList.remove("awake"), PLAYER_IDLE_MS);
  }
  frame.addEventListener("pointermove", wakeUp);
  frame.addEventListener("pointerdown", wakeUp);

  // Keys, while the player has the focus (after a click on it): space or K plays/pauses, ← → skip,
  // F fullscreen, M mute. Not those a focused button or slider uses itself (space presses a button,
  // arrows move a slider).
  frame.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const onButton = event.target.tagName === "BUTTON";
    const onSlider = event.target.tagName === "INPUT";
    const key = event.key.toLowerCase();
    if ((key === " " && !onButton && !onSlider) || key === "k") playOrPause();
    else if (key === "f") toggleFullscreen();
    else if (key === "m") toggleMute();
    else if (arrowKeys && !onSlider && (key === "arrowleft" || key === "arrowright")) {
      const step = key === "arrowleft" ? -SKIP_SECONDS : SKIP_SECONDS;
      video.currentTime = Math.max(0, Math.min(video.currentTime + step, video.duration || 0));
      showTime();
    } else return;
    event.preventDefault();  // (or space would also scroll the messages)
  });

  showTime();
  showPlaying();
  showSound();
  return frame;
}
