---
name: server-logs
description: Use when something went wrong on the live chat (no notification, a call that rang wrong, a crash, a bad voice call) and the server's logs can say what happened.
---

# Reading the live server's logs

Which log holds what: `docs/guides/running.md`, "Handy commands (on the server)". The chat runs from
`C:\ChatApp` on the server; its logs are in `C:\ChatApp\logs\`.

- **Over SSH from the dev PC** (the user prefers that to walking to the laptop). The server's shell is Windows:
  `findstr` works plainly, while a PowerShell one-liner's `$_` gets eaten by the quoting, so prefer
  `ssh chatserver "findstr /C:\"push call\" C:\chatapp\logs\chat.out.log"` and filter with `tail`/`grep` here.
- **Get the time first:** ask the user roughly when it happened, then read around that minute.
- **Pushes:** every push that should notify writes one line to `chat.out.log`, with who and why not:
  `push call in dm:1:2 for <name> (<id>): sent to the phone app`, or `not sent, <reason>`. The lines before it show
  what each of their devices was doing (looking, the Windows app in use, idle).
- **Voice:** `voice.log` (LiveKit): PacketsLost, RttMax, "ice reconnected" for the participant around the time.
- **Chattus:** `bot.log` (what he answered), `bot.errors.log` (crashes).
- **Names and ids only:** never copy message text from a log into a commit or doc.

Quote the log lines that settle it when explaining the cause to the user.
