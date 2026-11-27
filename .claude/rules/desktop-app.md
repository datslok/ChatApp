---
paths:
  - "desktop/**"
  - "releases/**"
---

# The Windows app

How it's built: `docs/notes/desktop-app.md`. The release steps: `docs/guides/desktop-app.md`.

- **A change to the app itself** (`desktop/src-tauri`: Rust, plugins, the icon, `tauri.conf.json`) ends with a built,
  signed and uploaded release, done by me as part of the job: `go-live` skill. Unless the user says to hold it.
- **Windows API or unsafe Rust:** try it in a small debug program first, then put it in the app.
- **Activity** never reports window titles other than games, Spotify and programs the user added.
- **The updates' signing key** (`~\.tauri\chatapp.key`) is never committed or regenerated: every installed app
  checks updates against it.
