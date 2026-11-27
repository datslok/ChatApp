---
name: go-live
description: Use when a change is finished and should reach friends: deploying the server and the phone app's live update, and releasing the Windows app when its code changed.
---

# Going live

A feature goes live everywhere at once. The commands and their details: `docs/guides/running.md`, "Updating";
the desktop release: `docs/guides/desktop-app.md`, "Releasing a version"; the phone APK:
`docs/guides/phone-app.md`, "Releasing the phone app".

1. **Committed and pushed first:** the server pulls from GitHub, so only what's pushed goes live.
2. **`scripts\app-update.ps1`:** it deploys the server (`deploy.ps1`: pull, packages, restart) and sends the phone
   app's JavaScript as a live update; "No new update" means the phone's JavaScript didn't change, which is fine.
   It refuses changes in `mobile/modules`, `mobile/plugins`, `app.json` or `package*.json`: those need a new APK
   (`scripts\app-release.ps1`), so tell the user.
3. **The Windows app's own code changed** (`desktop/src-tauri`, the icon, plugins): release it, as part of the job,
   unless the user says to hold it. Raise the version, build and sign (`npm run tauri build` in `desktop\`), update
   `releases\latest.json`, then `scripts\release-upload.ps1` (which also deploys).
4. **From away** (the laptop, outside the home network): every release script with `-ViaGitHub`.
5. **Check it's running:** the script ends with "The chat is running."; git's "From github.com" on stderr is
   harmless. For anything friends will test, say what to try and that the logs can show what happened
   (`server-logs` skill).

Never deploy something untested: `test.ps1` passed for server changes (in Claude's shells, the env's Python:
CLAUDE.local.md).
