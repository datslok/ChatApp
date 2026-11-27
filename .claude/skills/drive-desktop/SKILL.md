---
name: drive-desktop
description: Use before any test on this PC that plays sound, opens a visible window (Edge, Notepad, a test copy of the Windows app), takes focus, or closes programs.
---

# Testing on this PC

The user may be in a game or a call while I work: a loud tone once hurt their ears and lost them a match, and
killing every Notepad may have closed one of theirs.

1. **Ask first:** say exactly what will happen (which window opens, what sound plays, for how long) and wait for a
   yes. One yes covers one round; say when it's done.
2. **Quiet and short:** test sounds at low volume, seconds long, never a steady tone for minutes.
3. **Clean up straight after:** close what I opened.
4. **Stop only my own processes,** by process id or by my own profile path, never by name: the user may have the
   same program open. A hook blocks `Stop-Process -Name`, `taskkill /IM` and `Get-Process x | Stop-Process`.

No need to ask for background work that's invisible and silent: builds, the test suite, headless Edge with muted
audio (`check-page` skill).
