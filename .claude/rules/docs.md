---
paths:
  - "**/*.md"
  - "docs/**"
  - ".claude/**"
---

# Where new information goes

Pick the narrowest home. One home per fact; elsewhere, link to it.

| Kind | Home | Read by Claude |
|---|---|---|
| A milestone or step, planned or done | `ROADMAP.md` | When looked up |
| Anything done by hand: scripts, releases, server commands, backups | `docs/guides/<topic>.md`; scripts also in `docs/guides/scripts.md`, "Scripts at a glance" | When looked up |
| How it works inside, why, and what was tried (with dates) | `docs/notes/<area>.md`, its `Covers:` line naming its files | Before changing that area |
| What it is, how to try it, links to the guides | `README.md` (short) | When looked up |
| What friends see as new | `static/changelog.json` (`.claude/rules/whats-new.md`) | When editing it |
| How we work, rules for almost every task, our own hosting | root `CLAUDE.md` | Every session, in full |
| A rule for one part of the app | `.claude/rules/<part>.md` with `paths:` | Only when matching files are touched |
| A procedure | `.claude/skills/<name>/SKILL.md` | Only when the skill is used |
| A check a tool can make | a hook, the docs check or a test, not a rule | Never needs reading: it fails loudly |
| This PC's own facts (paths, keys' places, test passwords, shell quirks) | `CLAUDE.local.md`, git-ignored | Every session, never committed |

- **The repo is public:** the guides are for anyone hosting their own copy (example.com addresses, "your PC" and
  "the server"). Our own addresses and setup go only in CLAUDE.md's "Hosting"; anything private (home folders, email
  addresses, which secrets were never rotated) never in a committed file. The personal check refuses some of it.
- **Written for a reader:** short paragraphs of one idea, headings, bullets with a bold lead-in, tables for tabular
  data. In files Claude reads as rules, no paragraph past four sentences.
- **When behaviour changes, rewrite its section; don't append.** A note's "what was tried" keeps its date.
- **Budgets** (`tools/docs_check.py` fails past them): root `CLAUDE.md` 8 KB; each rule and skill 4 KB; `README.md`
  8 KB; each guide or notes file 20 KB. Past its budget a file splits by topic.
- **Compact, never lose meaning:** every fact, number and reason survives, moved to its home when over budget
  (`compact-docs` skill). Before each commit the hook names facts gone from every doc: say what was dropped and why.
- **Same commit:** a change updates its notes file, its guide (for a manual step), What's new (for a feature friends
  notice) and its ROADMAP.md tick.
