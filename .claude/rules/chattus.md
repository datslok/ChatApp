---
paths:
  - "chattus.py"
  - "chattus.ps1"
  - "llama.ps1"
  - "dev-chattus.env.example"
---

# Chattus, the AI bot

How he works: `docs/notes/chattus.md`.

- **A feature that depends on the model is switched on per model.** Small models fail where Claude doesn't: Qwen 3.5
  9B got clock arithmetic and dates wrong, so reminders are Claude-only. If someone switches back to Qwen, or tries
  another model, such features stay off for it.
- **The model only copies words into fields** (what, day, time); Python computes anything from them. The copied
  fields come first in a schema, since models write fields in order.
- **His API key** is set only by the user, with `scripts\set-server-secret.ps1`: never ask for it in the chat.
