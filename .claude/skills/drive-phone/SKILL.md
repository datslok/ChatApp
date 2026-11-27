---
name: drive-phone
description: Use before any test on the user's phone over adb (taps, key presses, screenshots, starting the app, shares), and when an Android build fails with EBUSY.
---

# Testing on the phone

The phone is the user's own, with their real ChatApp on it. Never touch it unannounced.

## Every round: ask first

1. **Ask:** "Ready, on the home screen, with the app closed?" and wait for a yes. One yes covers one round only:
   after "over to you", after a code change, or after they used the phone, ask again. The hook asks too, whenever
   the app is started (`am start`, `monkey`).
2. **Start the app myself** from the home screen, test, then say clearly "done, you can close it".
3. **Only the dev app:** tests target `no.datslok.chat.dev` ("ChatApp Dev"). The real app, `no.datslok.chat`
   (release-signed, the user's real account), is never cleared, force-stopped or uninstalled (a hook blocks it).

## Never their photos

Never open or screenshot the photo picker, gallery, albums, file browser or anything else holding their own
content: the picker can't show only a test file. When a test needs a file picked, hand that step to the user,
then test what our app does after.

## Logging in

dev.db's test accounts and their passwords: CLAUDE.local.md. Give the user the password instead of asking.

## EBUSY on mobile\android

`npx expo prebuild --clean` or a release build failing with "EBUSY: resource busy or locked" in `mobile\android`:

- **The adb server first:** `expo run:android` starts it with `android/` as its folder, which keeps it open.
  `adb kill-server`, then `adb reverse tcp:8001 tcp:8001` again.
- **Then Gradle's and Kotlin's daemons** left from an earlier build: `gradlew --stop`, or `Stop-Process` the two
  `java.exe` daemons by id (check their command line first). A failed release changes nothing: the script puts
  `app.json`'s version back.
- Run Gradle with `-p android` from `mobile/`, never with `android/` as the current folder.
