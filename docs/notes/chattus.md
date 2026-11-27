# Chattus, the AI bot

Covers: `chattus.py`, `chattus.ps1`, `llama.ps1`, `dev-chattus.env.example`, `tools/make_bot.py`

How the chat's AI bot Chattus works: the model and where it runs, the bot program `chattus.py`, how he reads
the chat and answers, and his tools (search, reading links and files, pictures, dice, polls, reminders, the
chat's manual). Chattus is milestone 23, still in progress: English, friendly, short chat-sized answers.

## The model

### Claude Haiku (in use)

Since 2026-10-13 he runs on **Claude Haiku 5.5**, until a better model is found:

- `CHATTUS_MODEL=claude-haiku-5-5` and `ANTHROPIC_API_KEY` in the server's `.env`; the `anthropic` package.
- Without `CHATTUS_MODEL` he's back on llama-server (below).
- `ask()` is the one place that calls a model. For Claude, `for_claude` turns the OpenAI-shaped conversation
  into `system` + messages: image blocks from the data URLs, and no leading or trailing assistant message.
- `claude_schema` closes every object (`additionalProperties: false`) and drops `maxItems` etc.
- `output_config`: effort `low` + `format` json_schema. `CLAUDE_MAX_TOKENS` is 2000 (its thinking counts).
  No temperature.
- While on Claude, the task "ChatApp AI" (llama-server) is disabled on the server, freeing the GPU. To go back
  to Qwen: `Enable-ScheduledTask "ChatApp AI"; Start-ScheduledTask "ChatApp AI"`, empty `CHATTUS_MODEL`, and
  restart the bot.
- The friends were told in What's new that what he reads goes to Anthropic.

The API key: my key (platform.claude.com, "Chattus server", made 2026-11-07) **expires 2027-02-28**. Make a
new one before then and put it in with `scripts\set-server-secret.ps1` (the user runs it). The key is shown
only once, right after Create key, and starts with sk-ant-; the list's `apikey_...` is its ID, not the key.

Several features work only with Claude: searching the chat, reading links and files, posting pictures,
reminders and the chat's manual (sections below). With Claude, web search also goes through Claude instead of
Exa.

### llama-server with Qwen (the earlier, self-hosted model)

The model ran on the server's GTX 1070 (8 GB; i7-6700HQ, 16 GB RAM):

- llama.cpp's `llama-server` in `llama/` (git-ignored). The version is `$LlamaVersion` in install.ps1: the
  CUDA 12.4 build + the cudart zip, checked against GitHub's digests.
- The model: Qwen 3.5 9B Q4_K_M + its mmproj (for pictures), from `unsloth/Qwen3.5-9B-GGUF`, in
  `llama/models/`.
- Started by `llama.ps1` (task "ChatApp AI", log in logs\ai.log). `install.ps1 -AI` sets it all up;
  `deploy.ps1 -AI` restarts it.
- Settings: all layers on the GPU, 8K context, 1 slot, 4 threads, thinking off, listening only on
  127.0.0.1:8080. Its key is `LLAMA_API_KEY` in `.env` (made on the server).
- Measured: ~25 tokens/s, 7.1 GB VRAM, ~13% CPU, ~110 W.

Tried and dropped:

- **Ollama** was tried first. 0.40's GPU discovery crashes (0xc0000005, ollama#16957; not caused by Python's
  vcruntime on PATH), and 0.24 found the GPU but couldn't pull Qwen 3.5.
- **Gemma 4 E4B** was faster (38 tokens/s), but Qwen won on tools and tone.

A system prompt asking for 1–3 short sentences keeps answers chat-sized.

## The bot program

The bot is `chattus.py`, run as the task "ChatApp bot" via `chattus.ps1` (log in logs\bot.log). `update.ps1`
restarts it on every deploy (see [operations.md](operations.md)).

### His account and connection

- The account Chattus is made by `tools/make_bot.py`: no email, a random password in `.env` as
  `CHATTUS_PASSWORD`, and `icon/chattuschattus_square.png` as his picture.
- He logs in with `/login` and uses the normal WebSocket at 127.0.0.1:8000. No server changes were needed
  except the channel with key `"chattus"` (`HOME`); channel names come from "channels" messages.
- A connection is in one channel at a time. So on an "unread" for #chattus, for a DM, or with "notify" /
  "mentions" (a mention), he "join"s that chat and uses its "history".

### How he answers

- He answers the newest message after his own last one. `answered` holds ids, against double answers.
- Never messages over 1 h old.
- One at a time (a queue), sending "typing" every 2 s.
- `reply_to` in shared channels (and in #chattus and DMs when someone wrote after the message).
- He defuses @everyone/@here. Max 400 tokens.
- He auto-accepts friend requests. That's rarely needed now: users.py's `befriend_bots` makes everyone a
  bot's friend at every start and at /register, /friends/remove refuses for bots, and the page shows no
  Remove for them (see [people.md](people.md)).
- He answers everything only in #chattus and his own DMs (`answers_everything`). In friends' DMs he answers
  only mentions, as replies.

### Bots in friends' DMs

- `users.is_bot` (set only by make_bot.py) lets a bot into a DM for an hour after a member names it there
  (`bot_invited`, `BOT_INVITE_TIME`).
- `save_mentions` saves a bot's DM mention by name, never via @everyone (see [messages.md](messages.md)).
- Calls use the strict `is_dm_member` (not `can_join`), so a bot never gets into DM calls (see
  [voice.md](voice.md)).

### Bots on the page

"users" has `"bot"`, so:

- the page's @ suggestions in a DM offer bots;
- the member list puts bots in a "Bots" section at the top (`#bots-list`, people.js `showUsers`);
- `makeBotBadge` adds a "BOT" tag (`--bot-badge`, the theme's accent) after a bot's name in the lists, above
  its messages and in its profile.

### Context

- The last 20 messages; with Claude 200 (`CLAUDE_CONTEXT_MESSAGES`), for which `join()` asks for "older" 50 at
  a time, like scrolling up.
- Each as "name: text": `<@id>` -> @name, `<:id>` -> :name:, files as "[sent a picture]".
- Context lines are "[09:43] name: text": local time, with the date when not today (`when()`). The prompt
  says he only sees those (up to 20) and should say when something is further back.
- `clean_answer` strips a copied "[time]" or "Chattus:" from his answer.

### Personality and prompt

- Personality: `SYSTEM_PROMPT`. The prompt makes him catlike (puns, nyan, ^-^, :3) and says to search when
  unsure instead of saying he doesn't know.
- The prompt tells him the chat draws LaTeX ($...$, $$...$$), so he writes formulas that way.
- Known quirk: he used to think any cat picture was him. Since 2026-10-13 `SYSTEM_PROMPT` describes his own
  icon (a black line-drawn cat face, pink tongue, blue rounded square), and Haiku tells it from other cats,
  blue ones too.

### Development

Run `.\chattus.ps1 -Dev` together with start.ps1 and `ssh -L 8080:127.0.0.1:8080 chatserver`. Its
`dev-chattus.env` (git-ignored) has a dev.db Chattus password and the server's LLAMA_API_KEY.

## Answers and reactions

Every answer is JSON `{"reaction", "reply"}` (`ANSWER_SCHEMA`, via llama-server's `response_format`
json_schema, enforced by grammar); either may be empty.

- The prompt asks for a reaction only when it adds something, reaction-only for thanks/goodbyes, and at most
  one emoji per message.
- `reaction_code` checks it against `/emoji.json` (fetched at start; with or without U+FE0F) or a custom
  emoji's name (-> `custom:<id>`). Anything else is dropped.
- Up to 50 custom emoji names are in the prompt.
- A message he reacted to counts as answered (after restarts too).

The first model call uses `ANSWER_OR_SEARCH_SCHEMA`, which adds fields for his tools (`search`, `roll`,
`poll`); with Claude it's `CLAUDE_ANSWER_SCHEMA`, which also has `search_chat`, `read`, `pictures` and
`remind`. `ask_model` returns a dict (it used to return (reaction, reply, poll)).

## Pictures he sees

With llama-server:

- The target message's (first) picture and the newest one in the 5 messages before it
  (`attachments_to_show`).
- Fetched from `/uploads/<id>` with his cookie, flattened on white, shrunk to a 768 px JPEG, and sent as a
  data URL in an `image_url` content part (~600 tokens, ~6 s).

With Claude:

- All the target's pictures and up to `CLAUDE_EARLIER_PICTURES` 3 in the `CLAUDE_PICTURE_LOOKBACK` 10
  messages before, instead of 1 at 768.
- Shrunk to `CLAUDE_PICTURE_SIZE` 1568 px (Claude's best size; ~2,500 tokens each).

### Custom emoji

A `LOOK_AT_EMOJI` job in the same queue describes each new emoji picture once (256 px, 8 words) into
`chattus-emoji.json` (git-ignored, keyed by file name). The prompt lists them as ":name: (note)".

## Web search

- The first model call uses `ANSWER_OR_SEARCH_SCHEMA` (a `search` field). If he fills it, or the message
  starts with "search:", `search()` runs it. "wiki:" means Wikipedia only, no Exa.
- The results go in as a user note, then a second call with `ANSWER_SCHEMA` (no more searching).
- A search he chooses himself that names a chat member isn't sent (the web knows nothing about them). Forced
  search:/wiki: always go. This is done in code because the 9B model ignored the prompt's rule.
- Max 100 searches a day (`searches_today`, kept across reconnects).

### With llama-server: Exa, then Wikipedia

- `exa_search` is a hand-written MCP client to `https://mcp.exa.ai/mcp`: JSON-RPC over HTTP POSTs
  (initialize, notifications/initialized, tools/call web_search_exa), reading SSE "data:" lines. It needs a
  User-Agent.
- Keyless by default. Its free limit is per IP and tight: it often refuses a second search within seconds
  ("rate limit" text -> `SearchRefused`).
- Then `wikipedia_search` (the en.wikipedia.org API: search + intro extracts).
- Optional `EXA_API_KEY` in .env (sent as `?exaApiKey=`).
- Tavily was dropped for Exa (Exa needs no account).
- Exa is only for llama-server.

### With Claude

`search()` uses `claude_search` instead of Exa:

- A separate small request with Claude's server-side `web_search_20250305` tool (Haiku's version;
  `_20260209` is Opus/Sonnet only), `max_uses` 3.
- It asks for a summary with links, plus the result pages' titles and URLs.
- It's a separate request so search citations can't clash with the answer's JSON shape.
- Wikipedia when it fails; "wiki:" stays Wikipedia.

## Searching the chat (only with Claude)

- A `search_chat` field (`CHAT_SEARCH_SCHEMA`: words, from) in `CLAUDE_ANSWER_SCHEMA`.
- `search_chat` runs in ask_model's thread and hands `ask_server_search` to the event loop
  (`run_coroutine_threadsafe`). There's a Future per "ask" in `chat_searches`, completed by handle's
  "search_results".
- It's the same WebSocket "search" as the page's 🔍 (see [messages.md](messages.md)).
- Privacy: the results are cut to the open channels (`open_channels`) plus the chat he was asked in. He's in
  every private channel, but #general mustn't hear #family. Never another DM or group of his, which he could
  read.
- Up to `CHAT_SEARCH_RESULTS` 20 lines "[when] here/in #x, name: text" go in as a note, then ANSWER_SCHEMA.

## Reading links (only with Claude)

- A `read` field (a link from the chat) in `CLAUDE_ANSWER_SCHEMA`.
- `claude_read` is a separate request with Claude's `web_fetch_20250910` (Haiku's version): `max_uses` 1,
  `max_content_tokens` `READ_PAGE_TOKENS` 10,000. It asks for what matters for the question.
- The result goes in as a note and he answers with `ANSWER_SCHEMA`: one page per question.
- Anthropic fetches the page, not the server, so there's no SSRF risk here.
- Big sites that block AI fetchers (BBC Good Food, Allrecipes, NRK) answer "no permission": he says he
  couldn't read it.

## Reading files (only with Claude)

- `file_kind` decides what he can read: PDFs up to `MAX_PDF_SIZE` 5 MB, and text files by suffix in
  `TEXT_FILES` (their first `MAX_TEXT_FILE` 50,000 characters).
- `attachments_to_show(..., file_kind, FILE_LOOKBACK 10, MAX_EARLIER_FILES 3)` picks the target's file and up
  to 3 in the 10 messages before (`FILE_LOOKBACK`, `MAX_EARLIER_FILES`).
- A PDF becomes our own `{"type": "pdf", "data": base64}` part, which `for_claude` turns into a `document`
  block.
- A text file goes into the message's text between "[sent the file x:]" and "[end of the file]".
- Too-big PDFs are named as such.

## Posting pictures (only with Claude)

- A `pictures` field (a search) in `CLAUDE_ANSWER_SCHEMA`.
- `commons_pictures` searches Wikimedia Commons: api.php, generator=search in File:, `filetype:bitmap`,
  imageinfo with a 1280 px `thumburl`, and Artist/LicenseShortName/ObjectName. It downloads up to 8
  JPEG/PNG, only from `COMMONS_FILE_HOSTS` (upload./thumb.wikimedia.org), so no SSRF.
- `find_pictures` shows them to Claude at 384 px, numbered. `PICK_SCHEMA` gets "pick" (numbers, checked by
  Python; at most 3) and the reply.
- Private things ("my cousin's party") get no pictures.
- Counts toward `MAX_SEARCHES_PER_DAY`.
- `answer()` sends the reply, then each picture as its own message (`upload`: POST /upload with his cookie),
  captioned "📷 title · author · licence · Wikimedia Commons". There's no link in it: that would make a
  preview card.
- Commons has no memes; a paid image search could replace it.

## Dice

- A `roll` field in `ANSWER_OR_SEARCH_SCHEMA` (dice notation like "2d6", "1d20+3"), or a message starting
  with "roll:" (checked first in `ask_model`, with no model call).
- `roll_dice` reads the notation anywhere in the text and rolls with `random` (1–20 dice, 2–1000 sides).
- Its text ("🎲 2d6: 4 + 2 = **6**") is the reply.

## Polls

- A `poll` object (`POLL_SCHEMA`: question, options with maxItems 10) in the same schema, or a message
  starting with "poll:" (`ONLY_POLL_SCHEMA`: the model only picks out the question and options).
- `poll_text` writes "📊 **question**" + 1️⃣..🔟 lines. With fewer than 2 options it says how to make one.
- `answer()` sends it, waits for the server's copy (`my_message`, a Future that `handle()` completes) to get
  its id, and reacts with each number.
- No end and no server changes: the reactions' counts are the result. His own reaction counts one, which the
  poll says.

## Reminders (only with Claude)

Qwen 9B got times wrong: reminders were tried on it and removed on 2026-10-13, then rebuilt for Claude only.

- `CLAUDE_TOOLS_PROMPT` is put into `{claude_tools}` only with Claude (single braces, as a format value).
- `remind` in `CLAUDE_ANSWER_SCHEMA` ("remind:" -> `ONLY_REMIND_SCHEMA`) has: what, day
  (today/tomorrow/weekday/MM-DD), time (HH:MM), in (amount + unit). They're in that order because the model
  writes fields in order.
- `reminder_moment` / timedelta work out the moment, so the model does no arithmetic.
- `save_reminder` checks it (in the future, within a year, 20 per person; up to 5 min in the past = the next
  minute) and confirms the saved time.
- A reminder asked for in a DM between friends goes to his own DM (no reply_to).
- Kept in `chattus-reminders.json` (git-ignored, loaded only with Claude).
- `watch_reminders` (every 30 s) queues `DELIVER_REMINDERS`; `deliver_reminders` joins the chat and sends
  "@name ⏰ what" as a reply, adding "(sorry, a bit late)" after 10 min.

## The chat's manual (only with Claude)

- `load_manual` fetches `/changelog.json` at every start and puts its `features` ("## topic" / "- item") into
  `{manual}`.
- `MANUAL_PROMPT`: answer how-to and where-is questions from it, with the way there, and don't make up
  settings.
- ~2,000 tokens; the whole prompt is ~2,800.

## The asker's device

Since 2026-10-18, the user's wish:

- `messages.sent_from` is "android app", "windows app", "phone browser" or "web browser". connections.py's
  `device_of` works it out from the connection's "looking": `android` (the phone app sends it), `app`,
  `mobile`.
- It's saved with each message and **sent to bots only**: `send()` strips it with `without_devices` for anyone
  whose connection isn't `bot` (messages, history/older/pins, search results, chat info items).
- chattus.py adds "(writing from the android app)" to the target's line. MANUAL_PROMPT says to give that
  device's way (the app's layout is in What's new, "On your phone").
- Tested in tests/test_devices.py (conftest's `bot` fixture uses make_bot.py).
