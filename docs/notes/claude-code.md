# Claude's own setup

Covers: `.claude/`, `tools/hooks/`, `tools/docs_check.py`, `tools/personal_check.py`, `tools/test_personal_check.py`, `tools/githooks/`

How the rules for Claude Code (the AI assistant this project is built with) are kept: in files that load only when
they're needed, and, where a script can check one, in a hook or check instead of prose. Copied from the same setup in
my other projects (milestone 25, 2026-11-27). Nothing here runs in the chat itself.

## Where the rules live

| File | Loads | Holds |
|---|---|---|
| `CLAUDE.md` | every session | how we work, the rules for almost every task, the notes index, our hosting's summary |
| `CLAUDE.local.md` (git-ignored) | every session, this PC only | this PC's facts: shells, where the keys are, test passwords |
| `.claude/rules/<part>.md` | when a file matching its `paths:` is touched | the rules for one part: server, web-page, phone-app, desktop-app, whats-new, chattus, hosting, docs |
| `.claude/skills/<name>/SKILL.md` | when the skill is used | a procedure: go-live, server-logs, drive-phone, drive-desktop, check-page, docs-review, compact-docs |
| `.claude/settings.json` | always | which hooks run when |

Claude's memory (outside the repo) keeps only dated reminders and private facts; project rules moved out of it into
these files on 2026-11-27, so they're in the repo, reviewable, and loaded only when relevant. Where each kind of
fact goes: `.claude/rules/docs.md`.

## The hooks

Claude Code runs a hook command at fixed moments of its own work and reads the answer from its exit code and
output. All of ours are one script, `tools/hooks/claude_hooks.py`, with a named check per moment:
`python -I tools/hooks/claude_hooks.py <check>`, the event as JSON on stdin. Only the standard library, so the
plain Python on PATH runs it.

| Check | When | Does |
|---|---|---|
| `commands` | before a Bash or PowerShell command | blocks what breaks a rule, asks before a phone test round, reminds before a commit |
| `edits` | before an Edit or Write | blocks text that breaks a rule |
| `line-endings` | after an edit or a command | puts back git's line endings in a file that flipped |
| `push` | when Claude ends its turn | keeps it going while commits aren't pushed |

**How a check answers:** exit code 2 with the reason on stderr blocks the call (after it, for `line-endings`, it
tells Claude). A permission question (`permissionDecision` `ask`) lets the user decide. A reminder
(`systemMessage` and `additionalContext`) lets the call run. The event is read as UTF-8 with an optional
byte-order mark, which a PowerShell pipe puts first.

### Reading a command line

A check sees each program a line runs, never text that only names one: a commit message saying "never pkill" runs
no pkill. Heredoc bodies are dropped; quoted text is masked while the line is split at `;`, `|`, `&&`, `||` and
line breaks. Each command's program is its first word after PowerShell's `&` and bash's `VAR=value`, by bare name.

### What `commands` blocks

- **AI attribution in a commit** (the user's global rule: they're the only author), in `-m` text or a `-F` file.
- **`--no-verify`** on a commit, push or merge: it would skip the personal check.
- **A secret staged for a commit** (`.env`, `dev-secrets.env`, `firebase-key.json`, keys like `.jks` and `.key`,
  `CLAUDE.local.md`), or forced past .gitignore with `git add -f`.
- **`npm install <package>` in `mobile/`:** `npx expo install` picks the versions Expo SDK 57 expects. `npm ci`
  passes.
- **Stopping programs by name** (`Stop-Process -Name`, `taskkill /IM`, `pkill`, `Get-Process notepad |
  Stop-Process`): the user may have the same program open; by id, or filtered by path, passes.
- **Touching the real phone app over adb** (`pm clear`, `force-stop`, `uninstall` of `no.datslok.chat`); the dev
  app, `no.datslok.chat.dev`, passes.
- **A new signing key** (`keytool -genkey…`, `tauri signer generate`): installed apps would refuse its updates.

It **asks** when adb starts the app (`am start`, `monkey`): every phone test round needs the user's yes
(`drive-phone` skill), and the permission question is that yes.

### Reminders before a commit

Never blocks: most commits (fixes, tuning) change nothing a note describes. Changes are measured against `HEAD`,
new files included, since `git add -A && git commit` stages in the same command.

- **Vanished facts:** each fact a changed doc had at `HEAD` that no doc has now (backticked names, link targets,
  numbers that say something: a decimal, two digits or more, or a unit). So compacting never loses one silently.
- **Stale notes:** changed code whose notes file didn't change, by that file. Each notes file's `Covers:` line
  names its files; the longest matching prefix wins (`voice.md`'s `chatapp/voice.py` over `server.md`'s
  `chatapp/`). Code no line claims is named too, so it gets a home.
- **What's new:** code friends could notice (`static/`, `mobile/`, `desktop/`, the server) without a
  `static/changelog.json` change.
- **Guides:** a script changed but no guide did.
- **Tests:** server code changed after `.pytest_cache` was last written, so test.ps1 hasn't run since.
- **The Windows app's code changed:** release it (`go-live` skill).

### What `edits` blocks

- **Anything in `mobile/android/`:** prebuild makes it.
- **Writing a secret file** (`.env`, keys).
- **`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`** in our `static/` code, except emptying
  (`= ""`) and `icons.js`, which puts our own fixed SVG shapes in that way. Comments and comparisons pass.
- **A test importing `server` or `chatapp`:** the tests are black-box.
- **Lock-screen flags** (`showWhenLocked`, `turnScreenOn`, full-screen intents) anywhere in `mobile/` except the
  incoming-call screen's files: `IncomingCallActivity.kt`, the push module's manifest that declares it,
  `Notifications.kt` whose full-screen intent opens it, and `PushModule.kt`, which asks for that permission.

Left out on purpose: "every colour in chat.css is a variable". The stylesheet sets 36 shadows and overlays with
plain black or white (`rgba(0, 0, 0, 0.6)`), so a check would block what the code already does.

### Line endings

The repo mixes CRLF files (`CLAUDE.md`, `ROADMAP.md`, much of `mobile/src`) and LF ones, and `sed -i` or Python's
`open(p, "w")` on Windows flips a whole file, turning a small edit into a whole-file diff (it happened four times on
2026-10-15). After each edit, `git ls-files --eol` compares the file with git's copy; a file now LF, CRLF or mixed
where git's is the other gets git's endings back, its text unchanged, and Claude is told. After a shell command,
only files changed in the last 2 minutes are looked at, never the user's own edits from before.

### Push

When Claude ends a turn with commits not pushed (`git rev-list @{u}..HEAD`), the hook keeps it going: "always push
after committing". Only once per turn (`stop_hook_active`): if pushing fails, offline say, Claude tells the user
instead of looping.

### Cost

One Python start per command or edit (a few tens of milliseconds); before a commit a few git calls and a read of
every doc; at the end of a turn one git call.

## The docs check

`tools/docs_check.py`, run by `test.ps1` after a whole run: it prints each problem and fails if there are any.

- **Budgets:** CLAUDE.md 8 KB, each rule and skill 4 KB, README 8 KB, each guide or notes file 20 KB.
- **Links** between docs lead to a file that exists, and to a heading it has (GitHub's anchors).
- **File names** in backticks are files in the repo, matched by their end (`src/voice.js` is mobile's), except
  those git never holds (logs, `latest.json`).
- **Section references** like `voice.py, "Calls in DMs and group DMs"` name a real `# ---------- … ----------`
  section, and `running.md, "Updating"` a real heading.
- **Covers:** every code file is claimed by a notes file, and every claimed path exists.
- **The notes index** in CLAUDE.md lists every notes file; **"Scripts at a glance"** names every script.
- **The guides** never name our own domain (they say example.com).
- **Rules** have `paths:` (or they'd load in every session); **skills** a `name:` matching their folder and a
  `description:`.
- **`static/changelog.json`** is valid JSON with its two lists.

## The personal check

The repo is public, so git hooks refuse a commit holding personal details. They run on every commit, the user's
and Claude's alike, as git runs them: `git config core.hooksPath tools/githooks` once per clone (git doesn't take
hooks from a clone by itself).

- `pre-commit` runs `python -I tools/personal_check.py staged`: every line the staged diff adds.
- `commit-msg` runs `python -I tools/personal_check.py message <file>`: the message, without git's `#` lines.

**What counts as personal:**

- **Home folders that name someone:** `C:\Users\<name>`, with either slash, and `/home/<name>`. Placeholders
  (`C:/Users/you`) and variables (`%USERPROFILE%`, `~`) pass.
- **Email addresses,** except GitHub's noreply ones, the example domains and their subdomains, `git@`, and file
  names like `128x128@2x.png`.
- **One's own list** in `~/.chatapp-private.txt`, outside the repo: a word or phrase per line, ignoring case.
  Local addresses go there, not in a pattern: examples (`192.168.1.50`) and tests (`10.x`) use them on purpose.
- **Vendored code** keeps its authors' notices (RNNoise's AUTHORS has an address): only the private list there.

Found while setting it up: the old CLAUDE.md held the laptop's cloudflared path, with the username in it. It moved
to CLAUDE.local.md.

## Tests

`tools/hooks/test_claude_hooks.py` and `tools/test_personal_check.py` (`unittest`), run by `test.ps1`: each check
fed made-up commands, edits and diffs, and both scripts run end to end as Claude Code and git run them. The
personal check's test builds every sample address from pieces, so it passes its own check. Both were seen to fail
with bugs planted in the code they guard.
