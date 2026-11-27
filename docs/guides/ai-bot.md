## Optional: an AI bot

**Chattus** is a friendly AI cat in the chat: an account like everyone's, which answers every message
in **#chattus**, anything that mentions **@Chattus** elsewhere (as a reply), and DMs to him (everyone
is friends with a bot: the server adds those friendships at every start and for each new account, and
they can't be removed). He reads the channel's last 20 messages (200 with Claude, see below). In a DM between two
people, a mention invites him in: he may then read and write there for an hour (never join its
calls), and only answers mentions. He can react instead of (or as well as) answering, and knows the
chat's custom emoji by name. He sees pictures: the one in the message he answers and the newest one
just before it (shrunk to 768 pixels first). He looks at each custom emoji once, and keeps a note of
what it shows in `chattus-emoji.json` (git-ignored; delete it to make him look again). The server knows he's a bot from `users.is_bot`, which only
`tools\make_bot.py` sets, so nobody can get this by naming themselves Chattus.

He writes maths as LaTeX ($...$), which the chat draws. He rolls dice ("roll a d20", or "roll: 2d6" without
the model; up to 20 dice and a modifier like `1d20+3`): the model only reads which dice, and Python rolls them. He
makes polls ("poll: Friday dinner? pizza, sushi, tacos", or in his own words): a message with up to 10 numbered
options, and the numbers as reactions under it, so voting is a click and the counts are the result. He searches the web when he needs fresh facts
("search: ..." makes him; "wiki: ..." searches only Wikipedia), at most 100 times a day:
with [Exa](https://exa.ai) through its MCP server, which works without an account but only allows a
few searches now and then from one internet address. When it says no, he searches Wikipedia instead.
For your own, bigger allowance, make a free account at exa.ai and put its key in `.env` as
`EXA_API_KEY`. Only the search words leave the server, never the chat's messages. (With Claude instead of the
local model, see below, he searches with Claude's own web search tool instead of Exa, paid per search.)

His language model runs on the server's own graphics card, with
[llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`): Qwen 3.5 9B, shrunk to 4 bits
per number, which also understands pictures. Nothing goes to an AI company. It needs an **NVIDIA
graphics card with 8 GB** (a GTX 1070 is enough: about 25 tokens, or 18 words, a second) with a driver
from 2024 or newer, and 7 GB of disk. In PowerShell as administrator:

```powershell
cd C:\ChatApp
.\scripts\server\install.ps1 -AI
```

It runs all of step 4 again (same questions), and then step 9: it downloads llama.cpp into `llama\`
and the model into `llama\models\` (6.3 GB; both checked against their published checksums), puts a
key for it (`LLAMA_API_KEY`) in `.env`, makes the bot's account (`tools\make_bot.py`: the account
**Chattus** with the app icon as its picture, and a random password in `.env` as `CHATTUS_PASSWORD`),
and makes two scheduled tasks: **ChatApp AI** runs `llama.ps1` (the model) and **ChatApp bot** runs
`chattus.ps1` (the bot, `chattus.py`), both at boot. The model is only reachable from the server
itself (`http://127.0.0.1:8080`), and only with that key. The bot connects to the chat on the server
too (`http://127.0.0.1:8000`), and logs in again by itself whenever the chat restarts.

The bot answers everything in the channel **#chattus** (its key `chattus` in the `channels` table: you
can rename it, but a new channel with that name isn't his). Without the bot, it's just a quiet channel
(delete it in Settings → Admin → Channels if you don't use the bot). His personality is `SYSTEM_PROMPT` at the top of
`chattus.py`.

The model lives on the graphics card the whole time (about 7 GB of its memory). The CPU stays nearly
free, so calls aren't affected. While it writes an answer, the graphics card works at full power for
a few seconds and the laptop gets warmer.

To talk to the model directly: llama-server has its own chat page. From your PC, open a tunnel to it
with `ssh -L 8080:127.0.0.1:8080 chatserver`, leave that window open, and go to http://localhost:8080.
It asks for the key: on the server, `Select-String LLAMA_API_KEY .env` shows it.

**Or Claude instead of the local model** (no graphics card needed): with `CHATTUS_MODEL` in `.env`, his
answers come from Anthropic's API, through its `anthropic` package. Make an account at
[platform.claude.com](https://platform.claude.com), add a little credit (and a monthly spending limit),
create an API key, and add two lines to `.env`, then restart the bot (`Stop-ScheduledTask "ChatApp bot";
Start-ScheduledTask "ChatApp bot"`):

```
CHATTUS_MODEL=claude-haiku-5-5
ANTHROPIC_API_KEY=sk-ant-...
```

Claude Haiku 5.5 is small, quick and cheap: a group of friends chatting with him costs well under a
dollar a month. **But then the chat's messages leave your server:** to answer, he sends Anthropic the
channel's last 200 messages and the pictures he looks at, so tell your friends. Without `CHATTUS_MODEL`
(or with the line empty), he uses the local model again.

**When the key expires** (a key can have an end date; an expired one quietly stops him), make a new one before
it does:

- In the Claude Console, Settings → API keys → Create key. Copy the long `sk-ant-...` text from the window that
  pops up: it's shown only once (the `apikey_...` in the list is its ID, not the key).
- On your PC, run `scripts\set-server-secret.ps1` and paste it when asked. It puts it in the server's `.env` and
  restarts the bot, without the key passing through anything else.
- Check `logs\bot.log` on the server for his next answer, then delete the old key in the Console.

With Claude he also **reads links** someone asks about ("what does this page say?"): Claude's own web fetch
tool reads the page (Anthropic's servers fetch it, not yours; at most about a long article's worth), and he answers
from it. Some big sites block AI readers; then he says he couldn't open it. He **reads files** people send
too: PDFs (up to 5 MB; their text and pages, scans included) and text files (`.txt`, `.md`, `.csv`, code...,
their first 50,000 characters), the one in the message he answers and up to 3 in the 10 messages before it.
Pictures the same way: up to 3 earlier ones besides the message's own, and sharper (1568 pixels instead of 768),
so small text in screenshots and photos is readable. And he knows how the chat works: at every start he reads
the `features` part of "What's new" (see [What's new](running.md#whats-new)), so "where do I change my theme?" gets the way
there. Keep that list complete, and say where each setting is.

With Claude he also keeps **reminders** ("remind me tomorrow at 9 to call mum", "in 20 minutes", or
"remind: ..."): the model copies the words into fields (a day, a time, or an amount and a unit) and Python
works out the moment; he confirms the time he saved, and then mentions the person where they asked (a DM
between friends: in their DM with him). They're kept in `chattus-reminders.json` (git-ignored), so restarts
don't lose them; times are the server's clock, up to a year ahead, at most 20 waiting per person. (The local
model got the times wrong too often, so it has no reminders.) With Claude, the ChatApp AI task (the local
model) isn't needed; disable it to free the graphics card (`Disable-ScheduledTask "ChatApp AI";
Stop-ScheduledTask "ChatApp AI"`).

**Working on the bot** on your PC, with the development chat (`start.ps1`) and the server's model
through that same tunnel:

```powershell
copy dev-chattus.env.example dev-chattus.env   # once (dev-chattus.env is git-ignored)
python tools\make_bot.py --db dev.db --uploads dev-uploads --env dev-chattus.env   # once: Chattus in dev.db
# then put the server's key in dev-chattus.env's LLAMA_API_KEY= line
.\chattus.ps1 -Dev    # with start.ps1 running, and the tunnel open in another window
```

With Claude, fill in `CHATTUS_MODEL` and `ANTHROPIC_API_KEY` in `dev-chattus.env` instead; no tunnel needed.
`dev-chattus.env.example` says what each line is.
