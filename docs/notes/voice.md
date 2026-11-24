# Voice, calls and screen sharing

How voice works: the self-hosted LiveKit server, calls in DMs and groups, what the web page does to the
microphone (noise suppression, the gate, push to talk), the floating call window, speaking rings, and screen
shares with their sound. The phone app's side of calls is in [phone-app.md](phone-app.md); the Windows app's
Rust code is in [desktop-app.md](desktop-app.md).

## The LiveKit server

Voice runs on a self-hosted LiveKit server.

- The program is `livekit/livekit-server.exe`, downloaded from github.com/livekit/livekit/releases (the
  windows_amd64 zip) and checked against `checksums.txt`. It is git-ignored.
- The server PC gets it from scripts\server\install.ps1, whose `$LiveKitVersion` should match this PC's (see
  [operations.md](operations.md)).
- Its settings are in `livekit.yaml`; it is started by `voice.ps1`.
- Its key and secret are `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in `.env`.

| Port | Protocol | Use | How it gets in |
|------|----------|-----|----------------|
| 7880 | TCP | signalling | through the tunnel |
| 7881 | TCP | audio | forwarded on the router |
| 7882 | UDP | audio | forwarded on the router |

The page uses LiveKit's browser library, `static/livekit-client-<version>.umd.js`: the UMD build from npm,
checked against npm's integrity hash, served at `/livekit-client-<version>.umd.js`.

## Calls in DMs and groups

Server side: voice.py, "Calls in DMs and group DMs".

- The room is the DM's or group's key.
- `is_call_member` (never bots) gates /voice-token and "voice".
- `calls[channel]["ringing"]` is the set of people still being rung (in a DM: the other one).
- "dm_call" (who's in the call) goes to `call_people`.

In a group:

- Everyone else rings.
- A decline only stops your own ringing (`call_answered` is sent to you).
- The first accept starts the call; the rest stop ringing after 30 s.
- The call ends when the room empties.

On the page (rooms.js `renderCallPanel`): a group's banner draws everyone in the call like the Lounge
(`renderGroupCallTiles`), while a DM's stays two tiles. 📞 Call joins without ringing when a call is already
going.

Testing: FastAPI's TestClient loses messages between connections (one event loop per connection), so test
ringing against real uvicorn + websockets clients.

## The microphone on the web page

The microphone goes through Web Audio before LiveKit sends it, in this order:

- the low cut (below),
- noise suppression,
- mic volume,
- then the noise gate `static/voice-gate.js`, an AudioWorklet.

The AudioContext runs at 48 kHz for RNNoise and DeepFilterNet. Voice settings are kept in the browser (localStorage
"voiceSettings").

### The low cut

Code: voice.js, "The low cut". Since 2026-11-24, always on (not a setting), on PCs.

- Why: someone walking past a desk made very loud low rumbles for the others. The table's shaking reaches a mic
  standing on it (10–80 Hz, below voices), and in a quiet room the levellers (DeepFilterNet's `postGain`, up to
  +15 dB, or the browser's automatic gain) raised it like a voice; it also opened the gate.
- What: two `BiquadFilterNode` high-passes at `LOW_CUT_HZ` 90, Q 0.5412 and 1.3066: a 4th-order Butterworth.
  Computed with the cookbook formulas at 48 kHz: -52 dB at 20 Hz, -28 at 40, -14 at 60, -3 at 90, -0.4 at 120,
  nothing from 165 Hz up.
- It's first, before noise suppression, so neither the levellers nor the gate see the rumble. `openMic` connects
  the new mic to it and re-points its output (`disconnect()` first) when the noise suppression changes.
- One biquad (12 dB per octave) is too gentle: Chrome's own audio processing already has a mild high-pass, and the
  steps came through it. Other apps' internals aren't published; 80–100 Hz low cuts are the standard for speech
  (mics' "low cut" switches, broadcast). A shock mount or mic arm stops it at the source.

### Noise suppression

| Setting | What it is |
|---------|------------|
| "Extra strong" (PCs, the default since 2026-11-23) | DeepFilterNet 3, WorkAdventure's worklet (see below) |
| "On" (the default before) | RNNoise 0.2, in our own worklet |
| "Light" | the browser's own noise suppression |
| "Off" | neither |

"On" has been RNNoise 0.2 since 2026-11-07, the same model as the phone's. Before that it was sapphi-red's
2022 build of the old RNNoise.

- Our worklet is `static/voice-denoiser.js` (no-cache, part of PAGE_VERSION).
- It imports `static/jitsi-rnnoise-0.2.1/rnnoise-sync.js`: npm's `@jitsi/rnnoise-wasm` 0.2.1, with the wasm
  inline as base64, loaded synchronously once per module. It was checked against npm's integrity hash and is
  served at `/jitsi-rnnoise-0.2.1/rnnoise-sync.js` with a week's caching. Its LICENSE and RNNoise's COPYING lie
  beside it.

**The cap.** Bug reports #8/#9 heard keyboard clicks as "marbles", and voices cut out and then jumped in loud.
So `ORIGINAL` 0.1 of the original sound is mixed back in (a -20 dB floor). It is held back `LATE_BY` 2 frames,
because 0.2 outputs 960 samples late (measured); out of step it would sound hollow. With the 10 ms of collecting,
that makes 30 ms of delay in all.

#### Extra strong: DeepFilterNet 3

Since 2026-11-23, because clicks still came through as marbles after the cap. First an extra choice; the same
day, after the user tried it in a call ("it sounds good"), the default. Saved settings say "on" even when nobody
chose it (voiceSettings is saved whole on any change), so voice.js switches a saved "on" to "strong" once per
browser (the `noiseUpgraded` marker; going back to On afterwards sticks). Light and Off stay. PCs only for now; the phone version is on ROADMAP's
parity list.

What other apps do (researched 2026-11-23): Discord and Jitsi's hosted service use Krisp (closed). OBS, Mumble and
werman's plugin offer RNNoise, whose known weakness is sharp sounds like keys. Chrome's WebRTC once had a keyboard
"transient suppressor", since removed. DeepFilterNet 3 is the open model newer projects move to.

The files:

- They come from npm's `@workadventure/noise-suppression` 0.2.0 (MIT). Only its DFN3 files are used, checked
  against npm's integrity hash: `deepfilternet.js` (the loader, an ES module), `deepfilternet-worklet-processor.js`,
  `df_bg.wasm` (libDF compiled to wasm, 15 MB) and `DeepFilterNet3_onnx.tar.gz` (the model, 8 MB).
- They're kept in `static/workadventure-ns-0.2.0/` with the package's LICENSE and DeepFilterNet's own MIT/Apache
  licences (fetched from its GitHub; the package left them out). The package's other 130 MB (DTLN, onnxruntime,
  silero) isn't used.
- They're served with a week's caching (a mount in server.py). Cloudflare brotli-compresses the wasm to 3.7 MB,
  so the download is ~12 MB. The model must not get `Content-Encoding: gzip`:
  the loader checks for gzip's first bytes itself (tests/test_misc.py).

voice.js, "Extra strong":

- `import()` loads it on first use, so only pages that choose it download it. Until it's ready RNNoise works,
  then `loadStrongFilter` calls `openMic` again to switch.
- `createDeepFilterNetAudioWorklet` gets two limits: the most attenuation while talking (`speechAttenuationDb`;
  unlimited sounds like dropouts) and in pauses, through its pause gate (`pauseAttenuationDb`, +30 ms of delay).
- `minSpeechFrames` 2: a sound must last 20 ms to open that gate, which key clicks don't.
- **Strength** (since 2026-11-24, `strongLevel`, the `#voice-strength` row, shown with Extra strong only).
  The user heard short words vanish completely: the pause gate only opens for a frame 10 dB above the floor
  that the denoiser kept (lost at most 15 dB), so a short "ja", "mm" or laugh the AI judges as noise stays at
  -45 dB. `STRONG_LEVELS`, talking/pauses in dB:

  | Strength | Talking | Pauses |
  |---|---|---|
  | Strong (the default) | 25 | 45 (the package's defaults) |
  | Medium | 20 | 30 |
  | Gentle | 15 | 15: the loader adds no pause gate when the two are equal, so nothing drops below -15 dB |

  The limits are fixed when the filter is made (`df_create`), so a change makes a new one
  (`loadStrongFilter` compares `strongFilter.level`). The old one keeps the mic until `openMic` has
  re-pointed the low cut, then it's disposed. A change made while one is being made is caught up in `finally`.
- `postGain`: its leveller after the filter, with the browser's `autoGainControl` off. Automatic gain works before
  any of our filters, so in pauses it turned the background up for them to fight ("pumping"). RNNoise still has
  the browser's.
- A load failure or the package's `onOverload` (this PC can't keep up) sets `strongProblem`: back to RNNoise until
  the page reloads, with a note under the setting (`#voice-noise-note`; "Downloading" shows only for the first
  filter, not for a change of strength). Any other choice disposes the filter.

Measured offline in headless Edge (2026-11-23), Windows' text-to-speech voice with synthetic key clicks:

| | Clicks with nobody talking | Speech | Clicks during speech |
|---|---|---|---|
| Input | -42.5 dB | -23.7 dB | -42.7 dB |
| RNNoise ("On", with the cap) | -58.3 dB | -23.9 dB | -53 dB |
| DeepFilterNet 3 | -87.5 dB | -24.0 dB | -50 dB |

Neither removes much of a click under speech (the voice hides it there anyway). The difference is in pauses:
RNNoise leaves clicks 16 dB down, still audible; DeepFilterNet removes them. It rendered 6 s in 0.6 s.

### Push to talk

Code: voice.js, "Push to talk"; voice-settings.js, "Input mode". Not on phones.

- `inputMode` "ptt" sends the gate `{ptt, talking}`, and the key opens the gate instead of the line (with the
  same 0.3 s hold).
- The key is kept as `pttKey` (event.code, or "Mouse1/3/4"), `pttWindowsKey` (event.keyCode = Windows'
  virtual-key code for the layout) and `pttName`.
- While the page has focus, the page's own key events count (not letters typed in a text box; blur counts as
  released).
- Without focus, the Windows app's count: `set_push_to_talk` (main.rs, since 0.1.19) and a thread polling
  `GetAsyncKeyState` (user32, declared by hand) every 15 ms, calling `pushToTalkFromApp(down)` on changes.
  Never RegisterHotKey, which would steal the key.

## The floating call window

Since 2026-10-15, the user's wish, everywhere. Code: rooms.js, "The floating call window".

When you're in a call but looking at something else, `#call-float` shows makeTile's tile of whoever talked last
(`lastSpeakerId`; in a DM, the other one).

- It is drawn from renderLoungeView, which every call or page change reaches, and from showSpeaking when someone
  else talks.
- It sits over #messages (or whatever page is showing) in a corner.
- It is dragged with pointer events and snapped to the nearest corner (localStorage "callFloatCorner").
- A click opens the call. The click is caught in the capture phase, before makeTile's toggleFocus.

Phone: `mobile/src/CallFloat.js`, with PanResponder + Animated (the capture variant, so a tap stays the tile's).
It is 160px 16:9, like the web's phone size, keeps its corner in voice settings' floatCorner, and sits above the
text box.

## Speaking rings

Code: voice.js, "Who's talking".

Speaking is measured in the page, not with LiveKit's ActiveSpeakersChanged, which only reports loud voices and
only every 500 ms.

- rooms.js plugs an AnalyserNode into each remote microphone track (`setWebAudioPlugins`, before their volume).
- `checkSpeaking` runs every 50 ms: RMS over `SPEAKING_LINE` (-50 dB) counts as speaking, held for
  `SPEAKING_HOLD_MS`.
- Our own ring is the gate's `open` report (`gateOpen`), so it matches what we actually send.

## Screen shares

Code: video.js. H.264, no simulcast, `maintain-framerate` at 60 fps.

### The H.264 profile

Chromium on Windows only uses the graphics card (Media Foundation, e.g. NVENC) for H.264 profile `42001f`. For
LiveKit's default `42e01f` it uses OpenH264 on the CPU.

- So `livekit.yaml`'s `enabled_codecs` adds the `42001f` fmtp line.
- It must keep plain `video/h264` too: LiveKit checks the name alone first, and without it falls back to VP8.
- Changing it needs `deploy.ps1 -Voice`, which ends ongoing calls.
- To check, the connection popup (voice.js) shows each share's encoder, profile and "held back by".

### A shared window's sound

Since app 0.1.24, the user's wish: browsers send no sound for a shared window.

0.1.23 crashed with heap corruption: windows-rs's PROPVARIANT has a Drop that runs PropVariantClear, which
"freed" our stack blob, so it's ManuallyDrop now. Test such code in a small debug program first.

How it works:

- The track's label is "window:<HWND>:0" (checked in Edge, 2026-10-25).
- video.js `startAppAudio` passes the HWND to main.rs's `start_app_audio`.
- app_audio.rs: GetWindowThreadProcessId, then Windows' process loopback (ActivateAudioInterfaceAsync on
  VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, INCLUDE_TARGET_PROCESS_TREE; Windows 10 2004+), 48 kHz stereo float,
  event-driven. It is refused for the app's own window (WebView2 plays the call), and stops by itself after 5 s
  unread.
- `static/app-audio.js` (an AudioWorklet, served at /app-audio.js, part of PAGE_VERSION) asks for more every 8
  blocks (~21 ms; the audio engine's clock isn't throttled in a minimised window).
- The page calls `invoke("read_app_audio")` (raw bytes = an ArrayBuffer), keeps 60 ms in hand, and skips back
  when it has more than 250 ms.
- It is published as ScreenShareAudio, musicHighQualityStereo + forceStereo (DTX/RED off).
- `stopAppAudio` is called by stopScreenShare, rooms.js's LocalTrackUnpublished and leaveVoice.

A whole screen keeps getDisplayMedia's systemAudio, asked for without echo cancellation, noise suppression or AGC,
and published like the window's. The user's wish: shared sound as it is; only the mic is processed.

This was only tested in a real call by the user (never play test sounds on this PC unasked).

### The "ChatApp is sharing your screen" bar

The user's wish: gone. WebView2/Chromium have no switch for it.

App 0.1.25's share_bar.rs `hide_share_bar` ShowWindow(SW_HIDE)s the first visible top-level window of a process
descended from ours (a Toolhelp snapshot: WebView2's msedgewebview2.exe) within 5 s.

**Not called since 2026-10-26.** It could hide the still-closing share picker instead of the bar, which left the
app unclickable (hand cursor everywhere) until a restart, and once the picker's Share button didn't respond. A
safer version would have to tell the bar from the picker (e.g. wait until the picker is gone, or match the bar's
size/position) and be tested on this PC first.
