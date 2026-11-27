# Files, pictures and videos

Covers: `chatapp/files.py`, `chatapp/web.py`, `static/js/viewer.js`, `static/js/video-player.js`

How uploaded files are stored and served: the upload size limit, thumbnails, videos and our own video player,
re-packing videos with ffmpeg, removing metadata from pictures, GIFs from GIPHY and link previews. For several
files in one message and the picture viewer, see [messages.md](messages.md).

## Uploads

- `uploads/` holds the uploaded files, saved under random names. It is git-ignored, like `chat.db`.
- `MAX_UPLOAD_SIZE` is 95 MB (2026-11-06; the user wanted 120). Each upload is one request, and Cloudflare's Free
  plan refuses requests over 100 MB, so going higher needs chunked uploads or a Business plan.
- `delete_upload` removes a file together with its thumbnails.

## Thumbnails

Since 2026-10-22. **The user's rule: a picture loads at the size it's shown; only the viewer loads the
original.**

### The server

- `/uploads/<id>?size=N` sends a WebP copy whose longest side is N. N must be one of `THUMB_SIZES`
  (200/400/800/1200), which is in LIMITS as `thumb_sizes`.
- The copy is made once by `make_thumbnail` and saved as `uploads/thumbs/<id>-<N>.webp`. It uses Pillow, JPEG
  `draft` (decoding a JPEG at a smaller size straight away) and `exif_transpose` (turning photos upright).
- Animations stay animated, up to MAX_THUMB_ANIMATION_PIXELS.
- Thumbnails are made one at a time (`thumbnail_lock`).
- When the copy would be no smaller, or the file can't be shrunk, the original is sent instead.

### The pages

- Web: messages.js `pictureUrl(file, shown)` asks for the shown size × devicePixelRatio. Tiles in a grid ask for
  × `COVER_FACTOR` 1.5 on top.
- Phone: files.js `pictureUri` (× PixelRatio). See [phone-messages.md](phone-messages.md).
- The viewer, ImageViewer, links and downloads keep the plain address (the original).

## Videos

Since 2026-10-15.

### The server

- `VIDEO_TYPES` (video/mp4, video/webm) are only believed if `is_video` finds the format's first bytes: "ftyp"
  at byte 4 for MP4, 1A 45 DF A3 for WebM.
- Videos are served inline like pictures (`SHOWN_TYPES`). FileResponse answers range requests, which is what
  lets players seek.
- `file_info` has `"video"`.
- `mark_old_videos()` runs at every start and turns earlier .mp4/.webm downloads that pass the check into
  videos.

### The web page

messages.js `makeVideo` puts a `<video preload="metadata">` in our player, with the `makeFileLink` under it. If
the format can't be played, only the link is left. The name under the video downloads it (the user's wish).

### Our video player

Since 2026-10-19, the user's wish: Chromium's own control bar hid the fullscreen button in ⋮ on narrow videos,
and a page can't add to that bar.

video-player.js `makeVideoPlayer(video, {arrowKeys})` draws its own controls (the video has no `controls`):

- The frame `.video-player`, with `.video-bar` over its bottom: the time bar and volume as
  `<input type="range">`, play, the time, mute, and fullscreen (of the frame).
- The bar shows only on hover (paused too, the user's wish) or with keyboard focus on the frame or a button.
  In fullscreen it hides 2 s after the mouse stops ("awake"), unless paused.
- Click = play/pause, double-click = fullscreen. Keys: space/K, ← →, M, F.
- `.tall` (videoHeight > videoWidth) makes the frame at least 1:1 (the user's wish).
- Container queries on the bar drop the volume below 260px and the time below 200px.
- The 400px limit is on the frame, not the video: put on the video, the frame came out 533px around a 400px
  video.
- The picture viewer (`#viewer-player`) uses it too, with arrowKeys false so ← → stay the viewer's stepping
  between files.
- The season popup keeps the browser's own controls.

### Volumes

Since 2026-10-16, the user's wish: every video starts at 30% and remembers its own volume.

- Web: messages.js `videoVolume`/`saveVideoVolume`, kept in localStorage "videoVolumes" by file id or seasonal
  path. The season dialog uses it too.
- Phone: VideoScreen.js, `video-volumes.json` by path, saved on close.
- Both keep the newest 200.

### The phone

The phone uses expo-video (more in [phone-messages.md](phone-messages.md)):

- `VideoAttachment` in MessageText.js shows the first frame with a play button.
- A tap opens `src/VideoScreen.js`, a popup with our control bar right under the video (the user's wish:
  Android's full screen had its controls at the bottom of the screen).
- A see-through Pressable lies over the VideoView, because the native view swallowed taps, so controls inside
  the message never worked.
- expo-video's player downloads with its own OkHttp client, without React Native's cookies. So
  `mobile/modules/cookies` (Kotlin, CookieManager.getCookie) hands it the login cookie as a header.

## Re-packing videos

files.py, "Re-packing videos"; since 2026-10-15.

### Why

Fragmented MP4s (from screen recorders and browser recordings) say length 0 in their header. Android's player
then shows no length and can't skip.

### How

- Every uploaded video is re-packed by ffmpeg before /upload answers: `-c copy`, `+faststart`,
  `-map 0:v -map 0:a?`, a 60 s limit, in a thread. If it fails, the original stays.
- `attachments.repacked` records it.
- `repack_old_videos` (started by the first connection) does older videos, and fragmented seasonal videos
  (`mp4_is_fragmented` reads the file's top-level boxes).
- `find_ffmpeg` also reads PATH from the registry, because a running server keeps its old PATH.
- ffmpeg is winget's Gyan.FFmpeg (install.ps1 step 1, machine scope; see [operations.md](operations.md)). The dev
  PC has it per user, with its bin folder on the user PATH.

### Sound

Since 2026-10-19, the user's wish: the player greys out the volume of a silent video.

- `FFPROBE` lives beside ffmpeg (e.g. WinGet\Links\ffprobe.exe).
- `has_audio` runs ffprobe -select_streams a; None = can't tell. It runs at upload, and in repack_old_videos for
  `attachments.audio IS NULL`.
- `file_info` gives videos `"audio"` (unknown counts as true).
- Web: video-player.js `setVideoAudio(frame, hasSound)` disables `.video-mute` and the volume slider.
- Phone: VideoScreen's `audio` prop (MessageText.js and ChatInfoScreen.js pass `file.audio !== false`) fades
  them, with pointerEvents "none".

## Removing metadata

files.py, "Removing metadata"; since 2026-11-15, the user's wish, after an iPhone photo showed its street
address in a phone's gallery.

- `/upload` runs `remove_metadata` on IMAGE_TYPES (the format is read from the first bytes) before the INSERT.
- Files are cut, not re-saved, so it's lossless (the tests compare pixels).
- The result must decode at the same size, or the original stays.

What's kept and dropped, by format:

| Format | What happens |
|--------|--------------|
| JPEG (`jpeg_without_metadata`) | Only APP0 JFIF, APP2 ICC_PROFILE and APP14 Adobe are kept; no COM. A tiny EXIF with only the orientation is put back. Nothing after the first EOI is kept (an MPO's gain map). |
| PNG | PNG_NOTES chunks dropped. |
| WebP | EXIF and "XMP " chunks dropped, and VP8X's flags cleared. |
| GIF | Untouched. |
| Downloads | Untouched (incl. iPhone .mov/HEIC, which are sent as downloads). |
| Videos | `-map_metadata -1` in repack_video. Rotation is display-matrix side data and stays (checked with the server's ffmpeg 9.0.2). |

- `attachments.cleaned` is 1 when it's done or was tried.
- `clean_old_uploads` (at the start of repack_old_videos, so at the first connection) does older files once,
  updating `size`. Videos wait for ffmpeg.
- The laptop has no ffmpeg, so the video test skips there.

## GIFs

web.py, "GIFs"; messages.js, "GIFs".

- The GIF button by the text box opens #gif-picker.
- `/gifs/search?q=` (trending without q) asks GIPHY's API via `fetch_url`, with `GIPHY_API_KEY` from .env. On the
  dev PC it's in the git-ignored `dev-secrets.env`, which start.ps1 loads.
- Answers are kept an hour in `gif_cache`, because the free key allows ~100 requests an hour for the whole site.
- 20 requests per person a minute (`gif_allowed`), rating pg-13, `bundle=messaging_non_clips`.
- The grid shows `fixed_width_downsampled` previews straight from GIPHY's servers (`is_giphy_url`).
- `/gifs/send {id}` downloads the original WebP (or the 200 px one if that's over 5 MB), checks it with Pillow and
  saves it as an ordinary attachment. The page then sends it as a message with that file.
- "Powered by GIPHY" is required by GIPHY.
- Tenor was the other option, but Google shut its API down on 2026-06-30.

## Link previews

web.py, "Link previews".

- After a message with a link goes out, a background task fetches the first link's page and reads its Open
  Graph tags.
- It saves a card in `link_previews` (one per message), with a shrunk WebP copy of the page's picture in
  `uploads/previews/`. That's served at `/previews/<name>` to whoever can see the message.
- A "preview" WebSocket message then adds the card to the pages.
- Not for links in `code`, and not on edits.

Against SSRF (the server being tricked into fetching private addresses):

- http/https on ports 80/443 only.
- Every address of the host must be public (`ipaddress.is_global`).
- We connect to the checked address ourselves, so there's no DNS rebinding.
- Redirects are checked by hand, 3 at most.
- 5 s timeouts, 1 MB of HTML, 5 MB pictures.
- 10 previews per person per minute.
