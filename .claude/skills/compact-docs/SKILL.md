---
name: compact-docs
description: Use when a doc, CLAUDE.md, rule or skill is over its budget, has grown hard to read, or the user asks to shorten docs. Shrinks them without losing a fact.
---

# Compact docs without losing meaning

Budgets and homes: `.claude/rules/docs.md`. The goal is the same facts in fewer words, each in its narrowest home.

**Meaning comes before size.** If a cut would drop or blur any meaning (a reason, a condition, a number, a nuance),
don't make it: split the file instead. Two files that keep every meaning beat one file under budget.

## Order of cuts (cheapest loss first)

1. **Move, don't delete:** a rule for one part of the app to `.claude/rules/`, a procedure to a skill, a manual
   step to a guide, this PC's facts to CLAUDE.local.md.
2. **Duplicates become links:** keep the fact in its one home, link to it from the others.
3. **Split by topic:** a notes or guide file past its budget becomes two narrower files (each notes file with its own
   `Covers:` line), both in CLAUDE.md's notes index. Never split mid-topic just to fit.
4. **Rules a tool can check become the tool:** a hook, the docs check or a test; then delete the prose.
5. **Then wording:** prose into bullets and tables, filler cut ("in order to" to "to"), one idea per bullet. Keep
   every name, number with its unit, link, date of a "what was tried" and reason.
6. **Delete only** what's no longer true (check the code first) or a duplicate whose home is named.

## Root CLAUDE.md

It loads into every session in full, so each byte costs on every task. Only a rule for almost every task, how we
work together, and our own hosting's summary belong there; a new rule merges with the one it overlaps; detail moves
out, leaving a line and a pointer.

## Check and report

- `python -I tools/docs_check.py` passes.
- Before the commit, the hook lists facts (backticked names, links, numbers with units) gone from every doc: for
  each, say where it moved, why it was stale, or put it back.
- Tell the user what was dropped and why. Never compact and change meaning in the same commit.
