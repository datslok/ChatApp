---
paths:
  - "static/changelog.json"
---

# What's new

`static/changelog.json` is what friends see in What's new, and Chattus reads its `features` as the chat's manual.

- **Every feature friends would notice** gets, in the same commit, a line in `changes` (on the same day: add to that
  day's entry) and an updated `features`. The commit hook reminds when code changed without it.
- **Written for friends:** short, no technical details, and say where things are ("Settings → Notifications").
- **Emoji** at the start of a `changes` line say what it's about (📞 calls, 📱 the phone app, 🪟 the Windows app).
- **Discreet features get no line:** admin-only, behind-the-scenes tools (private channels, limited and hidden
  roles) get no `changes` line and no `features` item, because hidden roles exist so friends don't learn about them.
  The README and notes still describe them. Ask when unsure.
- **Surprises wait:** a seasonal easter egg gets no line before its season, so it isn't spoiled.
