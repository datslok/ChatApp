# The PWA and Web Push

How the web chat works as an installable phone app (a PWA), how Web Push notifications are sent and shown, and
the banner and dialog that offer installing, push or the native app on phones. The native phone app's own push
(Firebase Cloud Messaging) is in [phone-app.md](phone-app.md).

## The PWA

The phone app was first a PWA. Its pieces:

- `static/manifest.json`, served at `/manifest.json`.
- `static/sw.js`, the service worker, served at `/sw.js` so it covers the whole site. It is registered by
  notifications.js and deliberately keeps no offline copies.
- Icons in `static/icons/`, served at `/icons/`, made by `tools/make_pwa_icons.py`.

The manifest and icons are linked from index.html and login.html. My girlfriend's phone is Android, so Android
comes first.

## Web Push

Push notifications use Web Push, with the `pywebpush` package. Server code: push.py.

### Keys and subscriptions

- The VAPID keys are in `.env`, made by `tools/make_vapid_keys.py`. They were made on the server itself, so the
  private key never left it. Development ones are in `dev.env`.
- The `push_subscriptions` table has one row per device.
- `/push/subscribe` and `/push/unsubscribe` only accept https endpoints at the known push services, against SSRF.
- The switch is in Settings → Notifications (notifications.js). It isn't in the Windows app.

### Sending

push.py's `send_push` sends them in a thread, in the background. A 404/410 answer deletes the subscription.

They go out:

- for new messages, to `save_mentions`' people (DMs, mentions, @everyone);
- for DM calls (ttl 30 s, urgency high).

But never:

- to someone "looking" at the chat on any device (each page sends `{"type": "looking"}` on focus/visibility
  changes);
- while they have the Windows app open at all (the page adds `app: inDesktopApp` to "looking"), unless nobody
  has been at that PC for their minutes (`pc_idle`; [people.md](people.md), "Away from the PC");
- to someone on Do Not Disturb;
- to a muted device (`/push/mute`).

push.py `why_no_push` has these rules (but muting) in one place, and says which one applied.

### The push log

Since 2026-11-26, after "I got no notification on my phone" (she was away from her PC, shown as idle) could only be
guessed at: every push that should notify (a message, a friend request, a call) writes one line per person to
stdout, which serve.ps1 sends to `logs\chat.out.log`: `2026-11-26 00:11:02 push message in dm:3:7 for kari (7):
sent to the phone app`, or `not sent, ` + why_no_push's reason, `no device with push on (or all muted)`, or
`FAILED: ...`. Names and ids only, never the text; bots are left out.

- serve.ps1 runs Python with `-u`: before, prints sat in an 8 KB buffer and chat.out.log stayed empty for days, so
  even "A push to the phone app failed" lines never showed up.
- tests/test_people.py `test_pushes_follow_the_pc_and_are_logged` reads the test server's log for these lines.

Also found then: a page "looking" on an idle PC that opened a chat (a "join", like the Windows app left in front
rejoining after a dropped connection) counted as seeing it, and its "read" push took the new notification off
the phone. The two `clear_on_phones` in server.py's "join" now skip an idle PC, like "looking" already did.

### Showing them

- sw.js shows them, one per channel (`tag`).
- On a tap it focuses an open chat (postMessage "open"), or opens `/?channel=..&message=..`, which core.js reads.
- A device with push on doesn't notify by itself (`pushOn`).

## The phone banner and the Android app dialog

On phones, a banner (`#phone-banner`, notifications.js) offers, until it's closed:

- first Install: Chrome's `beforeinstallprompt`, kept and used by our button. iPhones get the steps in words.
- then Turn on (push).

On Android it skips Install. Instead `#android-app-dialog` (notifications.js `offerAndroidApp`, after each
"welcome") offers the native app (the user's wish):

- Download -> /download.
- Not now or Back = ask again in a week (localStorage "androidAppAskAgain").
