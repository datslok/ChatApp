---
paths:
  - "mobile/**"
---

# The phone app

How it's built: `docs/notes/phone-app.md`. Testing on the phone over adb: `drive-phone` skill.

- **Expo SDK 57:** check Expo's docs for SDK 57 specifically. Packages only with `npx expo install` (a hook blocks
  `npm install` here). Never edit the generated `android/`: prebuild makes it from `app.json` and `plugins/`.
- **Changes in `mobile/modules`, `mobile/plugins`, `app.json` or `package*.json` need a new APK** (`app-update.ps1`
  refuses them), so leave those alone unless the APK is changing.
- **Styles:** `const makeStyles = (colors, size) => StyleSheet.create({...})`, never a module-level colour.
- **It copies the web chat's design,** in particular its phone layout (chat.css `@media (max-width: 700px)`): layout,
  Lucide icons, themes, message grouping, avatars, wording. Look at how the web draws a thing before building it,
  and name any difference and its phone reason (one screen at a time, long press instead of hover, Android's back).
- **Every feature the web and desktop app has:** never leave one to "the web for now" silently. What doesn't fit the
  current step goes on ROADMAP.md; name phone-only exceptions (Windows-only fonts, the app behaviour tab).
- **Never over the lock screen:** no `setShowWhenLocked`, no full-screen intent opening the app. The one exception
  is `IncomingCallActivity` (the caller's picture and name, Accept and Decline, nothing else); Accept asks to unlock
  first. Anyone holding a locked phone could otherwise read the chats. A hook blocks lock-screen flags elsewhere.
- **The release key** is never regenerated or overwritten, and never committed: Android only installs an update
  signed with the same key, so losing it means every friend reinstalling. Where it lives: `CLAUDE.local.md`.
- **Choosing from many people:** a type-to-search picker, never a drop-down (as on the web).
