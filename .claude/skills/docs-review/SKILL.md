---
name: docs-review
description: Use at the end of a milestone, after a large feature, or when the user asks to review the docs.
---

# Docs review

Homes and budgets: `.claude/rules/docs.md`. Shrinking: `compact-docs` skill.

1. **Placement:** read CLAUDE.md, every `.claude/rules/*`, every skill and the notes index. Move each item to its
   narrowest home; merge duplicates into one with links to it.
2. **Truth:** check each rule and each named file, function and `module.py, "Section"` against the code; fix or
   delete what's stale (deletions listed for the user first). Start from `python -I tools/docs_check.py`.
3. **Notes:** each `docs/notes/` file describes the code as it is now, with "what was tried" kept and dated. Its
   `Covers:` line names the files it describes; split any file over its budget by topic.
4. **Guides:** every script and manual step is in a guide and in `docs/guides/scripts.md`, "Scripts at a glance",
   written for anyone hosting their own copy (example.com, "your PC", "the server").
5. **Roadmap:** finished items ticked, the next ones still true.
6. **What's new:** `features` matches what the chat can do now (Chattus reads it as the manual).
7. **`README.md`:** short: what it is, how to try it, links to the guides.
8. **Memory:** project rules out of Claude's memory (they live in CLAUDE.md, rules or skills); this PC's facts in
   CLAUDE.local.md; duplicates merged; stale entries deleted. Memory keeps only dated reminders and private facts.
9. **Privacy:** no home folders, email addresses, local addresses or secrets in a committed file (the personal
   check covers some; grep for the rest).
10. `python -I tools/docs_check.py` passes; the hook's vanished facts are each explained to the user.
