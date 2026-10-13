"""Chattus, the chat's AI bot: a cat who answers in #chattus, in DMs to him, and when @mentioned.

He's an ordinary account (made by tools/make_bot.py) that logs in like the browser does and talks
to the chat over the same WebSocket. His answers come from the language model that llama.ps1 runs
on this PC (llama-server, at http://127.0.0.1:8080).

    python chattus.py                    # the real chat (http://127.0.0.1:8000), settings from .env
    python chattus.py --chat http://127.0.0.1:8001 --env dev-chattus.env     # the development chat

The env file needs CHATTUS_PASSWORD (tools/make_bot.py) and LLAMA_API_KEY (install.ps1 -AI).
On the server PC, a scheduled task runs this through chattus.ps1 (see scripts\\server\\install.ps1).

How he hears everything: a connection is "in" one channel at a time and only gets that channel's
messages in full. For any other channel it gets {"type": "unread"}, with a "notify" when the message
mentions him (DMs always do). So when an unread comes for a channel he should answer in, he joins
it, like clicking on it, and gets its history: exactly the context he needs.
"""
import argparse
import asyncio
import base64
import io
import json
import random
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import anthropic  # Anthropic's package for the Claude API (only used with CHATTUS_MODEL set)
from PIL import Image  # Pillow (in requirements.txt, for the server's pictures): shrinking pictures for the model
from websockets.asyncio.client import connect  # the WebSocket library (installed with uvicorn[standard])

Image.MAX_IMAGE_PIXELS = 25_000_000  # like server.py: refuse "decompression bombs" (tiny files claiming huge sizes)

HOME = "chattus"           # his own channel: he answers every message there
CONTEXT_MESSAGES = 20      # how many of the latest messages the model reads
CLAUDE_CONTEXT_MESSAGES = 200  # ... with Claude (fetched like scrolling up: 50 at a time)
MAX_ANSWER_TOKENS = 400    # an emergency brake on length (the prompt asks for short answers)
CLAUDE_MAX_TOKENS = 2000   # ... with Claude more, as its (short) thinking counts too
MAX_TEXT_LENGTH = 2000     # the chat's own limit for a message (server.py)
MAX_AGE = timedelta(hours=1)  # older messages are never answered (after he was offline for a while)

SYSTEM_PROMPT = """You are Chattus, a friendly and helpful cat who lives in a small group chat of friends.
You're playful and very catlike: you love cat puns (purrfect, pawsome, meowvelous, fur real, claws for celebration...)
and now and then you say "nyan" or "nya~", or put a ^-^ or :3 at the end of a sentence. Use them in most messages,
but lightly: one or two of these is plenty, and a real question still gets a clear, real answer.
Write like a person in a chat: usually one to three short sentences, no headings or bullet lists.
Only write more when someone asks you to explain something in detail. Use at most one emoji in a message, often none.
The messages you're given are the latest ones in this chat (up to {count}), oldest first. Each one from the others starts
with when it was sent and who sent it, like "[14:05] kari: hi" (with the date when it wasn't today). Don't start
yours with a time or your name. You can't see anything older than these: if someone asks about something further
back, say it's too far back for you to see.
If you don't know something or aren't sure, look it up with "search" (below) instead of guessing or saying you don't
know. Only say you don't know when a search can't help, like things about this chat that you can't see.
The chat draws maths written in LaTeX: $...$ inside a sentence, $$...$$ on a line of its own (no space just inside
the dollar signs). Use it whenever you write a formula, an equation or a symbol, like $E = mc^2$.
You can see pictures people send. A picture comes from the person whose message it's in; you never send pictures.
Not every cat in a picture is you.
{where}
Right now it's {now}.

You answer with JSON: "reply" is your message, and "reaction" is one emoji to put under the message you're answering.
- Most of the time, react with nothing (""). Only react when it adds something, like 🎉 for good news or 😂 for a really good joke.
- When a reaction says it all (a thanks, a goodbye, an "ok"), react and leave "reply" empty ("").
- Questions and requests always get a reply.
- "search": when you'd need facts you don't know, or that may have changed since you learned them (news, dates,
  prices, results, anything recent), write a short web search here and leave "reply" and "reaction" empty: you'll
  get the results and answer then. For everything else (chatting, opinions, things you know well) leave it "".
  Never search for things about this chat or the people in it: the web knows nothing about them.
- "roll": when someone asks you to roll dice, write them here in dice notation, like "1d20", "2d6" or "1d20+3", and
  leave everything else empty: the dice are rolled for you and the result is shown. Otherwise leave it "".
- "poll": when someone asks you to make a poll (a vote), put its question and its 2 to 10 options here, each short,
  and leave everything else empty: the poll is posted for you. Someone asking what you prefer is not a poll.
  Otherwise leave the question "" and the options [].{claude_tools}{custom}"""
# What he can only do with Claude: read a page someone linked, and reminders (the local model too often got
# the times wrong; the model only copies the words into the fields, and Python works out the moment).
CLAUDE_TOOLS_PROMPT = """
- "read": when someone asks about a link in the chat (what a page says, a summary, a question about it), put that
  link here, exactly as it was written, and leave everything else empty: you'll get what the page says and answer
  then. Otherwise leave it "".
- "remind": when someone asks you to remind them of something, put what in "what" (short, like "call mum"), and
  when, copied from their words without calculating anything: either "day" and "time" for a day and a clock time,
  like "tomorrow at 9": "day" is "today", "tomorrow", a weekday like "friday", or a date as "MM-DD" like "12-24"
  (or "" if they named none), and "time" is like "09:00" (or "" if they named none); or "in" for a time from now,
  like "in 20 minutes" or "in 2 days" (the number and the unit). Leave everything else empty: the reminder is saved,
  and they get a message then. Otherwise leave "what", "day" and "time" "", and "in" {"amount": 0, "unit": ""}."""
# (Single braces: this text is put into SYSTEM_PROMPT as a value, so format() leaves it as it is.)

# The shape every answer must have. llama-server turns it into grammar rules, so the model can't write
# anything else: always valid JSON with exactly these texts (any of them can be empty).
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"reaction": {"type": "string"}, "reply": {"type": "string"}},
    "required": ["reaction", "reply"],
}
# A poll: its question and options (an object inside the answer; maxItems: the grammar stops at 10).
POLL_SCHEMA = {
    "type": "object",
    "properties": {"question": {"type": "string"},
                   "options": {"type": "array", "items": {"type": "string"}, "maxItems": 10}},
    "required": ["question", "options"],
}
# The first time he's asked, he may also ask for a search, a dice roll or a poll; after search results, he has to answer.
ANSWER_OR_SEARCH_SCHEMA = {
    "type": "object",
    "properties": {"search": {"type": "string"}, "roll": {"type": "string"}, "poll": POLL_SCHEMA,
                   "reaction": {"type": "string"}, "reply": {"type": "string"}},
    "required": ["search", "roll", "poll", "reaction", "reply"],
}
# "poll: ...": only a poll.
ONLY_POLL_SCHEMA = {"type": "object", "properties": {"poll": POLL_SCHEMA}, "required": ["poll"]}
POLL_NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]  # one reaction per option

# A reminder (only with Claude): what, then when. The fields come in this order because the model writes
# them in order: the words it copied ("friday") first, so it doesn't decide on an "in" first.
REMINDER_UNITS = ["minutes", "hours", "days", "weeks"]  # (timedelta's own names for them)
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]  # (as weekday() counts)
REMIND_SCHEMA = {
    "type": "object",
    "properties": {"what": {"type": "string"}, "day": {"type": "string"}, "time": {"type": "string"},
                   "in": {"type": "object",
                          "properties": {"amount": {"type": "integer"}, "unit": {"enum": [""] + REMINDER_UNITS}},
                          "required": ["amount", "unit"]}},
    "required": ["what", "day", "time", "in"],
}
# With Claude, his first answer may also be a page to read or a reminder; "remind: ..." is only that.
CLAUDE_ANSWER_SCHEMA = {
    "type": "object",
    "properties": {**ANSWER_OR_SEARCH_SCHEMA["properties"], "read": {"type": "string"}, "remind": REMIND_SCHEMA},
    "required": ANSWER_OR_SEARCH_SCHEMA["required"] + ["read", "remind"],
}
READ_PAGE_TOKENS = 10_000  # at most this much of a page is read (a long article), so a huge one can't cost much
ONLY_REMIND_SCHEMA = {"type": "object", "properties": {"remind": REMIND_SCHEMA}, "required": ["remind"]}
MAX_CUSTOM_EMOJI = 50  # how many of the chat's own emoji the prompt lists by name

# Pictures: each costs the model ~600 tokens (of its 8192) and a few seconds, so only a couple.
PICTURE_SIZE = 768      # pixels on the longest side, shrunk to before the model sees it
PICTURE_LOOKBACK = 5    # besides the message he answers: the newest picture this many messages before it
EMOJI_NOTES = Path("chattus-emoji.json")  # what each custom emoji shows, in his words (git-ignored)

# Files he can read, only with Claude: PDFs (Claude reads their text and pages) and text files, chosen
# like pictures (the one he's answering, and the newest in the few messages before it).
TEXT_FILES = {".txt", ".md", ".csv", ".json", ".log", ".py", ".js", ".html", ".css", ".ps1", ".yaml", ".yml",
              ".xml", ".ini", ".toml", ".tex", ".srt"}
MAX_PDF_SIZE = 5 * 1024 * 1024   # bytes: a PDF costs ~2,000-3,000 tokens a page, so not huge ones
MAX_TEXT_FILE = 50_000           # characters of a text file (~12,000 tokens, a long essay)
FILE_LOOKBACK = 10               # besides the message he answers: files in this many messages before it...
MAX_EARLIER_FILES = 3            # ... at most this many (people send a few and talk about "the PDF above")
LOOK_AT_EMOJI = "(look at the custom emoji)"  # a job in the queue that isn't a channel

# Web search. Only the search words leave the server, never the chat's messages.
EXA_MCP = "https://mcp.exa.ai/mcp"  # Exa's search, through its MCP server: works without an account, but limited
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"  # when Exa says no: free, no account
USER_AGENT = "ChatApp-Chattus/1.0 (https://github.com/datslok/ChatApp)"  # who's asking (Wikipedia wants one)
SEARCH_RESULTS = 3          # results per search
SEARCH_TEXT = 1500          # characters per result the model reads (3 x 1500 ~ 1100 tokens)
MAX_SEARCHES_PER_DAY = 100  # so nobody can use up the free searches by spamming him
searches_today = {"day": None, "count": 0}  # (outside the Chattus object: kept when he reconnects)

# Dice: the model only says what to roll; Python rolls (models are bad at random numbers).
MAX_DICE = 20
MAX_SIDES = 1000

# Reminders (only with Claude): kept in a file, so restarts and deploys don't lose them. This PC's clock.
REMINDERS = Path("chattus-reminders.json")  # (git-ignored)
REMINDER_TIME = "%Y-%m-%d %H:%M"         # how a reminder's "at" is written in the file
REMINDER_CHECK = 30                      # seconds between looking for due reminders
MAX_REMINDERS_PER_PERSON = 20
MAX_REMINDER_AHEAD = timedelta(days=365)
DELIVER_REMINDERS = "(deliver reminders)"  # a job in the queue that isn't a channel, like LOOK_AT_EMOJI


class SearchRefused(Exception):
    """Exa's free limit was reached (or it said no in another way)."""


def log(text):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {text}", flush=True)  # flush: straight into the log file


def read_env(path):
    """NAME=value lines from an env file, as a dict (like serve.ps1 and llama.ps1 read .env)."""
    settings = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Z_]+)=(.*)$", line)
        if match:
            settings[match[1]] = match[2].strip()
    return settings


def post_json(url, data, headers=None):
    """POST some JSON and return (the answer's JSON, its headers). Blocking: run it in a thread."""
    request = urllib.request.Request(
        url, data=json.dumps(data).encode(), method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read() or b"null"), response.headers


def picture_data_url(raw, size=PICTURE_SIZE):
    """A picture (PNG, JPEG, GIF, WebP: any bytes Pillow reads) as a small JPEG in a data URL:
    "data:image/jpeg;base64,..." is the picture's bytes written out as text, so it fits in the JSON
    request. Shrunk so it costs the model few tokens; a GIF gives its first frame."""
    with Image.open(io.BytesIO(raw)) as picture:
        picture = picture.convert("RGBA")
        # JPEG has no transparency: put transparent parts (custom emoji often have them) on white,
        # or they'd turn black.
        flat = Image.new("RGB", picture.size, "white")
        flat.paste(picture, mask=picture.getchannel("A"))
        flat.thumbnail((size, size))  # shrinks to fit inside size x size, keeping the shape
        buffer = io.BytesIO()
        flat.save(buffer, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


# ---------- Web search ----------

def file_kind(file, any_size=False):
    """What kind of file he can read (with Claude), from a message's file: "pdf", "text", or None (a
    picture, another kind, or too big; any_size: whatever its size)."""
    if file["image"]:
        return None
    suffix = Path(file["filename"]).suffix.lower()
    if suffix == ".pdf" and (any_size or file["size"] <= MAX_PDF_SIZE):
        return "pdf"
    if suffix in TEXT_FILES:  # (only the first MAX_TEXT_FILE characters are read, so any size)
        return "text"
    return None


def for_claude(conversation):
    """A conversation in llama-server's (OpenAI's) shape as Claude's API wants it: (system, messages).
    The differences: the system prompt is a field of its own, a picture is an "image" block instead of
    a data URL, and the messages must start with a person's (and end with one: Claude's newest models
    don't continue a message of their own)."""
    system, messages = "", []
    for message in conversation:
        content = message["content"]
        if message["role"] == "system":
            system += content
            continue
        if isinstance(content, list):  # text and a picture
            parts = []
            for part in content:
                if part["type"] == "image_url":
                    # "data:image/jpeg;base64,/9j/4AAQ..." -> the type and the base64 text after the comma
                    header, data = part["image_url"]["url"].split(",", 1)
                    media_type = header.removeprefix("data:").removesuffix(";base64")
                    parts.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
                elif part["type"] == "pdf":  # (our own part, only ever made with Claude: a PDF, in base64)
                    parts.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                                  "data": part["data"]}})
                elif part.get("text"):
                    parts.append({"type": "text", "text": part["text"]})
            content = parts
        if content:  # (Claude refuses empty messages)
            messages.append({"role": message["role"], "content": content})
    while messages and messages[0]["role"] == "assistant":
        messages.pop(0)
    while messages and messages[-1]["role"] == "assistant":
        messages.pop()
    return system, messages


def claude_schema(schema):
    """A JSON shape as Claude's structured outputs want it: every object closed to other fields
    ("additionalProperties": false), and without the limits it doesn't support (maxItems, minimum, ...).
    A copy: the original stays as llama-server wants it."""
    if isinstance(schema, dict):
        copy = {key: claude_schema(value) for key, value in schema.items()
                if key not in ("maxItems", "minItems", "minimum", "maximum", "pattern")}
        if copy.get("type") == "object":
            copy["additionalProperties"] = False
        return copy
    if isinstance(schema, list):
        return [claude_schema(item) for item in schema]
    return schema


def exa_search(query, api_key=None):
    """Search the web with Exa, through its MCP server. Blocking. Raises SearchRefused at its limit.

    MCP (Model Context Protocol) is a standard way for AI programs to use tools. Underneath, it's
    JSON-RPC: small JSON messages like {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ...},
    each POSTed to the server. A conversation is: "initialize" (the server answers with a session id,
    which every later message carries), "notifications/initialized" (we're ready), then "tools/call".
    Answers come as "server-sent events": lines like "data: {...}"."""
    url = EXA_MCP + (f"?exaApiKey={api_key}" if api_key else "")  # with a key: our own (bigger) allowance
    session = None

    def send(method, params, expect_answer=True):
        nonlocal session
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if expect_answer:
            message["id"] = 1  # (a "notification" has no id, and gets no answer)
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "User-Agent": USER_AGENT}
        if session:
            headers["Mcp-Session-Id"] = session
        request = urllib.request.Request(url, json.dumps(message).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            session = response.headers.get("Mcp-Session-Id") or session
            raw = response.read().decode("utf-8", "replace")
        if not expect_answer:
            return None
        for line in raw.splitlines():  # an event stream: the JSON is on the "data:" line
            if line.startswith("data:"):
                return json.loads(line[5:])
        return json.loads(raw)  # (or plain JSON)

    send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "chattus", "version": "1.0"}})
    send("notifications/initialized", {}, expect_answer=False)
    answer = send("tools/call", {"name": "web_search_exa", "arguments": {"query": query, "numResults": SEARCH_RESULTS}})
    if "error" in answer:
        raise SearchRefused(answer["error"].get("message", "error"))
    text = "".join(part.get("text", "") for part in answer["result"]["content"])
    if "rate limit" in text.lower() or answer["result"].get("isError"):
        raise SearchRefused(text[:200])
    return text[:SEARCH_RESULTS * SEARCH_TEXT]


def wikipedia_search(query):
    """Search English Wikipedia: the best few articles' titles, addresses and opening paragraphs.
    Blocking. Free and without an account, for when Exa says no."""
    def get(params):
        address = WIKIPEDIA_API + "?" + urllib.parse.urlencode({**params, "format": "json"})
        request = urllib.request.Request(address, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())

    found = get({"action": "query", "list": "search", "srsearch": query, "srlimit": SEARCH_RESULTS})
    titles = [hit["title"] for hit in found["query"]["search"]]
    if not titles:
        return ""
    # The articles' opening sections as plain text ("extracts"), all in one request.
    pages = get({"action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1, "titles": "|".join(titles)})
    extracts = {page["title"]: page.get("extract", "") for page in pages["query"]["pages"].values()}
    results = []
    for title in titles:
        link = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))
        results.append(f"Title: {title}\nURL: {link}\n{extracts.get(title, '')[:SEARCH_TEXT]}")
    return "\n\n".join(results)


def has_time(remind):
    """Does the model's "remind" say when: a "day" or a "time", or an "in" with an amount and a unit?"""
    if not isinstance(remind, dict):
        return False
    relative = remind.get("in") if isinstance(remind.get("in"), dict) else {}
    return bool(remind.get("day") or remind.get("time")) or (bool(relative.get("unit")) and (relative.get("amount") or 0) > 0)


def reminder_moment(day, time, now):
    """The moment a "day" and a "time" mean, from now: ("tomorrow", "09:00") -> tomorrow at 9. No time
    means 09:00; no day means today, or tomorrow when that time has passed ("at 8", said in the evening);
    a weekday is the next one (today itself if that time is still to come), and a date ("12-24") the next
    one too (reminders only go a year ahead, so the model never has to guess a year). None if it can't be read."""
    try:
        clock = datetime.strptime(time or "09:00", "%H:%M").time()
        if day in ("", "today"):
            on = now.date()
        elif day == "tomorrow":
            on = now.date() + timedelta(days=1)
        elif day in WEEKDAYS:
            on = now.date() + timedelta(days=(WEEKDAYS.index(day) - now.weekday()) % 7)  # 0-6 days ahead
        else:
            on = date.fromisoformat(f"{now.year}-{day}")  # "12-24" -> this year's 24 December
    except ValueError:  # "25:99", "02-31", "next week", ...
        return None
    moment = datetime.combine(on, clock)
    if moment <= now and day == "":
        moment += timedelta(days=1)
    elif moment <= now and day in WEEKDAYS:
        moment += timedelta(days=7)
    elif moment <= now and day not in ("today", "tomorrow"):
        try:
            moment = moment.replace(year=now.year + 1)  # that date has been: next year's
        except ValueError:  # 29 February, and next year has none
            return None
    return moment


def roll_dice(spec):
    """Roll dice written like "2d6", "d20" or "1d20+3" (count, "d", sides, an optional modifier), and say
    how it went, like "🎲 2d6: 4 + 2 = **6**". Finds the notation anywhere in the text ("d20 for initiative")."""
    match = re.search(r"\b(\d*)d(\d+)(?:\s*([+-])\s*(\d+))?\b", spec, re.IGNORECASE)
    if not match:
        return f"🎲 I can't roll \"{spec.strip()[:50]}\": write dice like 2d6, d20 or 1d20+3."
    count = int(match[1] or 1)  # "d20" means one die
    sides = int(match[2])
    modifier = int(match[4] or 0) * (-1 if match[3] == "-" else 1)
    if not 1 <= count <= MAX_DICE or not 2 <= sides <= MAX_SIDES:
        return f"🎲 I can roll 1 to {MAX_DICE} dice, with 2 to {MAX_SIDES} sides each."

    rolls = [random.randint(1, sides) for _ in range(count)]
    total = sum(rolls) + modifier
    name = f"{count}d{sides}" + (f"{modifier:+d}" if modifier else "")  # :+d writes the sign: +3 or -2
    if count == 1 and not modifier:
        return f"🎲 {name}: **{total}**"
    sums = " + ".join(map(str, rolls))
    if modifier:
        sums += f" {'+' if modifier > 0 else '-'} {abs(modifier)}"
    return f"🎲 {name}: {sums} = **{total}**"


class Chattus:
    def __init__(self, chat_url, llama_url, password, llama_key, exa_key=None, claude_model=None, anthropic_key=None):
        self.chat_url = chat_url
        self.llama_url = llama_url
        self.password = password
        self.llama_key = llama_key
        self.exa_key = exa_key  # optional: Exa's search works without one, but with a smaller, shared limit
        # With a Claude model (CHATTUS_MODEL), the answers come from Anthropic's API instead of llama-server.
        self.claude_model = claude_model
        self.claude = anthropic.Anthropic(api_key=anthropic_key) if claude_model else None
        # How many of a chat's latest messages the model reads (Claude's memory is far bigger)
        self.context_messages = CLAUDE_CONTEXT_MESSAGES if claude_model else CONTEXT_MESSAGES
        self.cookie = None      # "session=..." after logging in
        self.websocket = None
        self.my_id = None
        self.names = {}         # user id -> username, for turning <@2> into @kari
        self.emoji = {}         # custom emoji id -> name, for turning <:17> into :pog:
        self.emoji_files = {}   # custom emoji id -> its picture's file name
        self.emoji_notes = json.loads(EMOJI_NOTES.read_text(encoding="utf-8")) if EMOJI_NOTES.exists() else {}
        # (file name -> what it shows, like "a surprised face": a replaced picture gets a new file name)
        self.allowed_emoji = set()  # every emoji the server accepts as a reaction (static/emoji.json)
        self.channel = None     # the channel we've joined
        self.messages = {}      # channel -> its latest messages (from "history", then live ones)
        self.history_arrived = None  # a Future the reader completes when a joined channel's history comes
        self.my_message = None  # ... and one it completes when the server sends back a message we wrote
        self.queue = asyncio.Queue()  # channels to look at, one after the other
        self.queued = set()     # ... the same, to never queue one twice
        self.answered = set()   # ids of messages we've answered (so never twice, whatever the timing)
        self.friends = set()    # user ids of his friends (a DM needs a friendship)
        # Waiting reminders, only with Claude: [{"user_id", "name", "channel", "reply_to", "at", "what"}, ...]
        self.reminders = []
        if self.claude and REMINDERS.exists():
            self.reminders = json.loads(REMINDERS.read_text(encoding="utf-8"))

    # ---------- Connecting ----------

    def log_in(self):
        """POST /login, like the login page, and keep the session cookie from the answer."""
        _, headers = post_json(f"{self.chat_url}/login", {"username": "Chattus", "password": self.password})
        for header in headers.get_all("Set-Cookie") or []:
            if header.startswith("session="):
                self.cookie = header.split(";")[0]  # "session=abc...; HttpOnly; ..." -> "session=abc..."
                return
        raise RuntimeError("Logged in, but got no session cookie.")

    def load_emoji(self):
        """The emoji list the page's picker uses: {"groups": [{"name", "emoji": [["😀", "grinning face"], ...]}]}.
        The server only accepts reactions from it (and custom emoji), so we check against it first."""
        with urllib.request.urlopen(f"{self.chat_url}/emoji.json", timeout=30) as response:
            groups = json.loads(response.read())["groups"]
        self.allowed_emoji = {emoji for group in groups for emoji, _ in group["emoji"]}

    def fetch(self, path):
        """A file from the chat (a picture), with our login: the server only gives it to people who
        may see the message it's in. Blocking: run it in a thread."""
        request = urllib.request.Request(f"{self.chat_url}{path}", headers={"Cookie": self.cookie})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()

    async def run(self):
        """Log in, connect and work, until the connection drops (then run() returns or raises)."""
        await asyncio.to_thread(self.log_in)
        await asyncio.to_thread(self.load_emoji)
        ws_url = self.chat_url.replace("http", "ws", 1) + "/ws"
        async with connect(ws_url, additional_headers={"Cookie": self.cookie}, max_size=2**24) as websocket:
            self.websocket = websocket
            self.channel = None
            log("Connected.")
            self.enqueue(HOME)  # catch up on our own channel first
            worker = asyncio.create_task(self.work())
            timer = asyncio.create_task(self.watch_reminders()) if self.claude else None
            try:
                async for raw in websocket:  # each message from the server, until it closes
                    await self.handle(json.loads(raw))
            finally:
                worker.cancel()
                if timer:
                    timer.cancel()

    async def send(self, data):
        await self.websocket.send(json.dumps(data))

    # ---------- What the server tells us ----------

    async def handle(self, data):
        kind = data.get("type")
        if kind == "welcome":
            self.my_id = data["id"]
        elif kind == "users":
            self.names = {user["id"]: user["name"] for user in data["users"]}
        elif kind == "custom_emoji":  # at the start, and whenever one is added, replaced or deleted
            self.emoji = {emoji["id"]: emoji["name"] for emoji in data["emoji"]}
            self.emoji_files = {emoji["id"]: emoji["file"] for emoji in data["emoji"]}
            if any(file not in self.emoji_notes for file in self.emoji_files.values()):
                self.enqueue(LOOK_AT_EMOJI)  # new ones to look at (in the queue: one model job at a time)
        elif kind == "friends":
            self.friends = set(data["friends"])
            # Anyone may DM him: accept every friend request (DMs need a friendship).
            for user_id in data["incoming"]:
                await asyncio.to_thread(post_json, f"{self.chat_url}/friends/accept", {"user_id": user_id},
                                        {"Cookie": self.cookie})
                self.friends.add(user_id)
                log(f"Accepted a friend request from {self.names.get(user_id, user_id)}.")
        elif kind == "history":
            self.messages[data["channel"]] = data["messages"]
            if self.history_arrived and not self.history_arrived.done():
                self.history_arrived.set_result(data.get("more"))  # (are there older ones?)
        elif kind == "older":
            # Messages from before the ones we have (we asked, like scrolling up in the page): in front.
            self.messages[data["channel"]] = data["messages"] + self.messages.get(data["channel"], [])
            if self.history_arrived and not self.history_arrived.done():
                self.history_arrived.set_result(data.get("more"))
        elif kind == "message":
            channel = data["channel"]
            self.messages.setdefault(channel, []).append(data)
            del self.messages[channel][:-max(50, self.context_messages)]  # keep the latest ones
            if data["user_id"] == self.my_id and self.my_message and not self.my_message.done():
                self.my_message.set_result(data)  # answer() is waiting for its id (a poll)
            if self.should_answer(data, channel):
                self.enqueue(channel)
        elif kind == "unread":
            # A message somewhere else. "notify" (or a count in "mentions") means it mentions us.
            mentions = data.get("mentions") or {}
            notified = (data.get("notify") or {}).get("channel")
            for channel in data["channels"]:
                if channel == self.channel:
                    continue  # we get those live
                if self.answers_everything(channel) or channel == notified or mentions.get(channel):
                    self.enqueue(channel)

    def answers_everything(self, channel):
        """#chattus and DMs with him: every message is for him. Everywhere else (other channels, and
        DMs between two friends, which a mention lets him into for an hour) only mentions are."""
        return channel == HOME or (channel.startswith("dm:") and str(self.my_id) in channel.split(":")[1:])

    def should_answer(self, message, channel):
        """Is this a message we should answer? Not our own (no talking to ourselves), not a call
        note, not too old, and: anything in #chattus and his DMs, elsewhere only when it mentions us."""
        if message["user_id"] in (None, self.my_id) or message.get("kind") or not (message["text"] or message["file"]):
            return False
        sent = datetime.fromisoformat(message["sent_at"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) - sent > MAX_AGE:
            return False
        return self.answers_everything(channel) or f"<@{self.my_id}>" in message["text"]

    def enqueue(self, channel):
        if channel not in self.queued:
            self.queued.add(channel)
            self.queue.put_nowait(channel)

    # ---------- Answering ----------

    async def work(self):
        """One channel at a time, like llama-server: one answer at a time."""
        while True:
            channel = await self.queue.get()
            self.queued.discard(channel)
            try:
                if channel == LOOK_AT_EMOJI:
                    await asyncio.to_thread(self.look_at_emoji)
                elif channel == DELIVER_REMINDERS:
                    await self.deliver_reminders()
                else:
                    await self.answer(channel)
            except Exception as error:  # a broken answer must not stop the bot
                log(f"Couldn't answer in {channel}: {error!r}")

    def look_at_emoji(self):
        """Look at each custom emoji we haven't seen, and note in a few words what it shows, so the
        prompt can say ":pog: (a surprised face)". Once per picture, saved in EMOJI_NOTES. Blocking."""
        for emoji_id, file in list(self.emoji_files.items()):
            if file in self.emoji_notes:
                continue
            name = self.emoji.get(emoji_id, "emoji")
            picture = picture_data_url(self.fetch(f"/custom-emoji/files/{file}"), size=256)
            note = self.ask([{"role": "user", "content": [
                {"type": "text", "text": f"This is a custom emoji called :{name}: in a group chat. "
                                         "What does it show? Answer in at most eight words, no full sentence."},
                {"type": "image_url", "image_url": {"url": picture}},
            ]}], max_tokens=30, temperature=0.2).strip().rstrip(".")
            self.emoji_notes[file] = note[:100]
            EMOJI_NOTES.write_text(json.dumps(self.emoji_notes, indent=1, ensure_ascii=False), encoding="utf-8")
            log(f"Looked at :{name}: -> {note!r}")

    async def join(self, channel):
        """Open a channel (like clicking on it) and wait for its history (the latest 50). With Claude,
        then ask for older ones (like scrolling up), 50 at a time, until he has context_messages."""
        self.history_arrived = asyncio.get_running_loop().create_future()
        self.channel = channel
        await self.send({"type": "join", "channel": channel})
        try:
            more = await asyncio.wait_for(self.history_arrived, timeout=10)
        except TimeoutError:  # the server said nothing: not a channel we may join
            self.channel = None
            raise
        while more and len(self.messages.get(channel, [])) < self.context_messages:
            self.history_arrived = asyncio.get_running_loop().create_future()
            await self.send({"type": "older", "before": self.messages[channel][0]["id"]})
            more = await asyncio.wait_for(self.history_arrived, timeout=10)

    async def answer(self, channel):
        if channel != self.channel:
            await self.join(channel)
        messages = self.messages.get(channel, [])

        # The newest message after our own last one that wants an answer. (If several came in,
        # one answer for the newest, with all of them in its context.)
        target = None
        for message in reversed(messages):
            if message["user_id"] == self.my_id or message["id"] in self.answered:
                break
            if any(self.my_id in r["user_ids"] for r in message.get("reactions") or []):
                break  # answered with just a reaction (remembered by the server, also after a restart)
            if self.should_answer(message, channel):
                target = message
                break
        if target is None:
            return
        self.answered.add(target["id"])

        log(f"Answering {target['name']} in {channel}: {target['text'][:80]!r}")
        typing = asyncio.create_task(self.keep_typing())
        try:
            result = await asyncio.to_thread(self.ask_model, channel, messages, target)
        finally:
            typing.cancel()

        reaction = self.reaction_code(result.get("reaction", ""))
        mine = any(r["emoji"] == reaction and self.my_id in r["user_ids"] for r in target.get("reactions") or [])
        if reaction and not mine:  # (reacting again would take it away: reactions are a toggle)
            await self.send({"type": "react", "message_id": target["id"], "emoji": reaction})
        text = result.get("reply", "")
        options = 0
        if result.get("poll") is not None:
            text, options = self.poll_text(result["poll"])
        if result.get("remind") is not None:
            text = self.save_reminder(result["remind"], target, channel)
        text = self.clean_answer(text)
        if not text:
            return  # just a reaction (or nothing at all)

        reply = {"type": "message", "text": text}
        # Shown as a reply when it isn't obvious what he's answering: always where he only answers
        # mentions, and in #chattus and his DMs when someone else wrote after that message.
        if not self.answers_everything(channel) or messages[-1] is not target:
            reply["reply_to"] = target["id"]
        # A poll: wait for the server to send our message back (only then does it have an id), and
        # put a number under it for each option, so voting is one click.
        self.my_message = asyncio.get_running_loop().create_future()
        await self.send(reply)
        if options:
            sent = await asyncio.wait_for(self.my_message, timeout=10)
            for number in POLL_NUMBERS[:options]:
                await self.send({"type": "react", "message_id": sent["id"], "emoji": number})
        # (Messages that came while he was thinking queued this channel again: handle() did that.)

    async def keep_typing(self):
        """'Chattus is typing…' while the model writes. The page forgets it after 3 quiet seconds."""
        while True:
            await self.send({"type": "typing"})
            await asyncio.sleep(2)

    # ---------- Reminders (only with Claude) ----------

    def save_reminder(self, remind, target, channel):
        """Save a reminder the model read from a message and say so, or say what's wrong with it. When is
        "day" and "time" ("tomorrow", "09:00": reminder_moment) or "in" ({"amount": 20, "unit": "minutes"}:
        added to now). The time in the answer is the one saved, so a misunderstanding shows at once."""
        what = self.clean_answer(str(remind.get("what", "")))[:500]
        now = datetime.now()
        day, time = str(remind.get("day", "")).strip().lower(), str(remind.get("time", "")).strip()
        relative = remind.get("in") if isinstance(remind.get("in"), dict) else {}
        amount, unit = relative.get("amount"), relative.get("unit")
        if day or time:  # (when the model filled in both, the words it copied win)
            at = reminder_moment(day, time, now)
        elif unit in REMINDER_UNITS and isinstance(amount, int) and amount > 0:
            try:
                at = now + timedelta(**{unit: amount})  # timedelta(minutes=20): Python does the arithmetic
            except OverflowError:  # (an absurd amount: far beyond the year's limit below anyway)
                return "⏰ I can only remember things up to a year ahead."
            at = (at + timedelta(seconds=30)).replace(second=0, microsecond=0)  # to the nearest whole minute
        else:
            at = None
        if at is None:
            return "⏰ I couldn't tell when. Try something like \"remind me tomorrow at 9 to call mum\"."
        if not what:
            return "⏰ What should I remind you of? Try something like \"remind me tomorrow at 9 to call mum\"."
        if now - timedelta(minutes=5) < at <= now:
            at = now.replace(second=0, microsecond=0) + timedelta(minutes=1)  # "at 08:17", said at 08:17: right away
        when = f"{at:%a %d %b}" + (f" {at.year}" if at.year != now.year else "") + f" at {at:%H:%M}"
        if at <= now:
            return f"⏰ {when} has already been. Pick a time that's still to come!"
        if at - now > MAX_REMINDER_AHEAD:
            return "⏰ I can only remember things up to a year ahead."
        user_id = target["user_id"]
        if sum(1 for reminder in self.reminders if reminder["user_id"] == user_id) >= MAX_REMINDERS_PER_PERSON:
            return f"⏰ You already have {MAX_REMINDERS_PER_PERSON} reminders waiting, that's all I can keep for you."

        # In a DM between two friends he may only be for an hour: the reminder comes in his own DM with them.
        where, reply_to, note = channel, target["id"], ""
        if channel.startswith("dm:") and not self.answers_everything(channel):
            where = "dm:{}:{}".format(*sorted((self.my_id, user_id)))
            reply_to = None  # (that message is in another chat)
            note = " in our DM" if user_id in self.friends else " in our DM, so add me as a friend first"
        self.reminders.append({"user_id": user_id, "name": target["name"], "channel": where, "reply_to": reply_to,
                               "at": at.strftime(REMINDER_TIME), "what": what})
        self.reminders.sort(key=lambda reminder: reminder["at"])  # ("2026-10-14 09:00" sorts like a time)
        self.save_reminders()
        log(f"Reminder for {target['name']} at {at:{REMINDER_TIME}} in {where}: {what!r} (the model: {remind})")
        return f"⏰ Okay! I'll remind you on {when}{note}: {what}"

    def save_reminders(self):
        REMINDERS.write_text(json.dumps(self.reminders, indent=1, ensure_ascii=False), encoding="utf-8")

    async def watch_reminders(self):
        """Every REMINDER_CHECK seconds: is a reminder due? Then deliver them through the queue (a
        connection is in one channel at a time, so never in the middle of an answer)."""
        while True:
            now = datetime.now().strftime(REMINDER_TIME)
            if any(reminder["at"] <= now for reminder in self.reminders):
                self.enqueue(DELIVER_REMINDERS)
            await asyncio.sleep(REMINDER_CHECK)

    async def deliver_reminders(self):
        """Post every due reminder where it was asked for: "@kari ⏰ call mum", as a reply to that message."""
        now = datetime.now()
        for reminder in [r for r in self.reminders if r["at"] <= now.strftime(REMINDER_TIME)]:
            # Gone from the list first: one that can't be delivered (no longer friends, say) mustn't
            # be tried again every 30 seconds forever.
            self.reminders.remove(reminder)
            self.save_reminders()
            name = self.names.get(reminder["user_id"], reminder["name"])  # (in case they've renamed)
            late = now - datetime.strptime(reminder["at"], REMINDER_TIME) > timedelta(minutes=10)
            text = f"@{name} ⏰ {reminder['what']}" + (" (sorry, a bit late: I was away)" if late else "")
            try:
                if reminder["channel"] != self.channel:
                    await self.join(reminder["channel"])
                message = {"type": "message", "text": text}
                if reminder["reply_to"]:
                    message["reply_to"] = reminder["reply_to"]
                await self.send(message)
                log(f"Reminded {name} in {reminder['channel']}: {reminder['what']!r}")
            except Exception as error:
                log(f"Couldn't remind {name} in {reminder['channel']}: {error!r}")

    # ---------- The model ----------

    def readable(self, text):
        """The chat's tokens as people write them: <@2> -> @kari, <@everyone> -> @everyone, <:17> -> :pog:."""
        text = re.sub(r"<@(\d+)>", lambda m: "@" + self.names.get(int(m[1]), "someone"), text)
        text = text.replace("<@everyone>", "@everyone")
        return re.sub(r"<:(\d+)>", lambda m: ":" + self.emoji.get(int(m[1]), "emoji") + ":", text)

    def when(self, message):
        """When a message was sent, in this PC's time: "09:43" today, "11 Oct 09:43" on other days.
        (The server sends UTC, like "2026-10-12T07:43:00Z".)"""
        sent = datetime.fromisoformat(message["sent_at"].replace("Z", "+00:00")).astimezone()
        return f"{sent:%H:%M}" if sent.date() == date.today() else f"{sent:%d %b %H:%M}"

    def where(self, channel):
        if channel == HOME:
            return "You're in #chattus, your own channel: every message there is for you."
        if channel.startswith("dm:"):
            people = [self.names.get(int(part), "someone") for part in channel.split(":")[1:] if int(part) != self.my_id]
            if len(people) == 1:
                return f"You're in a private chat with {people[0]}."
            return (f"You're in a private chat between {people[0]} and {people[1]}. One of them mentioned "
                    "you (@Chattus) to ask you something: answer that, and keep out of the rest.")
        return f"You're in #{channel}, a channel for everyone. Someone mentioned you (@Chattus)."

    def attachments_to_show(self, messages, target, wanted, lookback=PICTURE_LOOKBACK, earlier=1):
        """The ids of the messages whose file the model gets to see (wanted(file): a picture, say): the
        one he's answering, and the newest `earlier` ones in the `lookback` messages before it ("what's in
        the picture above?")."""
        def has(message):
            return bool(message["file"] and wanted(message["file"]))

        shown = {target["id"]} if has(target) else set()
        before = [m for m in messages if m["id"] < target["id"]][-lookback:]
        for message in [m for m in reversed(before) if has(m)][:earlier]:
            shown.add(message["id"])
        return shown

    def ask_model(self, channel, messages, target):
        """The latest messages as a conversation for the model, and its answer as a dict: "reaction" and
        "reply" (texts), or a "poll" ({"question", "options"}) or a "remind" ({"what", "day", "time", "in"};
        only with Claude) to make. Blocking (run it in a thread)."""
        forced_roll = re.match(r"^\s*(?:@\S+\s+)?roll:\s*(.+)", self.readable(target["text"]), re.IGNORECASE | re.DOTALL)
        if forced_roll:
            return {"reply": roll_dice(forced_roll[1])}  # "roll: 2d6": no model needed

        custom_emoji = sorted(self.emoji.items(), key=lambda item: item[1].lower())[:MAX_CUSTOM_EMOJI]
        listed = []
        for emoji_id, name in custom_emoji:
            note = self.emoji_notes.get(self.emoji_files.get(emoji_id))
            listed.append(f":{name}: ({note})" if note else f":{name}:")
        custom = ("\nThe chat also has its own emoji, which you can use in your reply or as your reaction by writing "
                  "their name like this: " + ", ".join(listed)) if listed else ""
        conversation = [{
            "role": "system",
            "content": SYSTEM_PROMPT.format(where=self.where(channel), now=f"{datetime.now():%A %d %B %Y, %H:%M}",
                                            custom=custom, claude_tools=CLAUDE_TOOLS_PROMPT if self.claude else "",
                                            count=self.context_messages),
        }]
        show = self.attachments_to_show(messages, target, lambda file: file["image"])
        read = self.attachments_to_show(messages, target, file_kind, FILE_LOOKBACK, MAX_EARLIER_FILES) if self.claude else set()
        for message in messages[-self.context_messages:]:
            if message.get("kind"):
                continue  # call notes ("a call started") aren't conversation
            text = self.readable(message["text"])
            picture = pdf = None
            told = False  # has the text already said what the file is?
            if message["id"] in show:
                try:
                    picture = picture_data_url(self.fetch(f"/uploads/{message['file']['id']}"))
                except Exception as error:  # gone, or not a picture Pillow can read: just say there was one
                    log(f"Couldn't look at the picture in message {message['id']}: {error!r}")
            elif message["id"] in read:
                name = message["file"]["filename"]
                try:
                    raw = self.fetch(f"/uploads/{message['file']['id']}")
                    if file_kind(message["file"]) == "pdf":
                        pdf = base64.standard_b64encode(raw).decode("ascii")
                    else:  # a text file: its text right into the message
                        content = raw.decode("utf-8", errors="replace")
                        cut = " (cut off here: the file is longer)" if len(content) > MAX_TEXT_FILE else ""
                        text = (text + "\n" if text else "") + f"[sent the file {name}:]\n{content[:MAX_TEXT_FILE]}\n[end of the file{cut}]"
                        told = True
                except Exception as error:
                    log(f"Couldn't read the file in message {message['id']}: {error!r}")
            elif (message["file"] and self.claude and message["file"]["size"] > MAX_PDF_SIZE
                  and file_kind(message["file"], any_size=True) == "pdf"):
                text = (text + " " if text else "") + f"[sent a PDF too big for you to read: {message['file']['filename']}]"
                told = True
            if message["file"] and picture is None and pdf is None and not told:  # just that there was one
                sent = "a picture" if message["file"]["image"] else f"a file: {message['file']['filename']}"
                text = (text + " " if text else "") + f"[sent {sent}]"
            if message["user_id"] == self.my_id:
                conversation.append({"role": "assistant", "content": text})
                continue
            replying = f"(replying to {message['reply']['name']}) " if (message.get("reply") or {}).get("name") else ""
            line = f"[{self.when(message)}] {message['name']}: {replying}{text}"
            if picture:
                # A message with a picture: its content is a list of parts, the text and the picture.
                line += " [sent this picture:]" if text else "[sent this picture:]"
                conversation.append({"role": "user", "content": [
                    {"type": "text", "text": line},
                    {"type": "image_url", "image_url": {"url": picture}},
                ]})
            elif pdf:
                # A PDF, like a picture: a part of its own (for_claude makes it a "document" block).
                line += f" [sent this PDF, {message['file']['filename']}:]"
                conversation.append({"role": "user", "content": [{"type": "text", "text": line},
                                                                 {"type": "pdf", "data": pdf}]})
            else:
                conversation.append({"role": "user", "content": line})

        # "poll: ..." always makes a poll, "remind: ..." (with Claude) a reminder: the model only picks out the parts.
        if re.match(r"^\s*(?:@\S+\s+)?poll:", self.readable(target["text"]), re.IGNORECASE):
            conversation.append({"role": "user", "content": "[Make a poll of the last message: its question and options.]"})
            poll = self.complete(conversation, ONLY_POLL_SCHEMA).get("poll")
            return {"poll": poll if isinstance(poll, dict) else {}}  # ({}: poll_text says what's missing)
        if self.claude and re.match(r"^\s*(?:@\S+\s+)?remind:", self.readable(target["text"]), re.IGNORECASE):
            conversation.append({"role": "user", "content": "[Make a reminder of the last message: what and when.]"})
            remind = self.complete(conversation, ONLY_REMIND_SCHEMA).get("remind")
            return {"remind": remind if isinstance(remind, dict) else {}}  # ({}: save_reminder says what's missing)

        # "search: ..." always searches the web, "wiki: ..." always searches Wikipedia (also after
        # "@Chattus"). Otherwise he decides: his first answer may be a search, a dice roll, a poll or
        # (with Claude) a reminder.
        forced = re.match(r"^\s*(?:@\S+\s+)?(search|wiki):\s*(.+)", self.readable(target["text"]),
                          re.IGNORECASE | re.DOTALL)
        wiki_only = bool(forced) and forced[1].lower() == "wiki"
        if forced:
            query = forced[2].strip()
        else:
            answer = self.complete(conversation, CLAUDE_ANSWER_SCHEMA if self.claude else ANSWER_OR_SEARCH_SCHEMA)
            reaction = answer.get("reaction", "")
            if answer.get("roll", "").strip():
                return {"reaction": reaction, "reply": roll_dice(answer["roll"])}
            if has_time(answer.get("remind")):
                return {"reaction": reaction, "remind": answer["remind"]}
            poll = answer.get("poll")
            if isinstance(poll, dict) and poll.get("options"):
                return {"reaction": reaction, "poll": poll}
            url = answer.get("read", "").strip() if self.claude else ""
            if url:
                # What the page says goes into the conversation as a note, and he's asked again (like
                # search results; ANSWER_SCHEMA has no "read", so one page per question).
                conversation.append({"role": "user", "content": (
                    f"[What the page {url} says]\n{self.claude_read(url, self.readable(target['text']))}\n\n"
                    "[Now answer the conversation above with this.]"
                )})
                answer = self.complete(conversation, ANSWER_SCHEMA)
                return {"reaction": answer.get("reaction", ""), "reply": answer.get("reply", "")}
            query = answer.get("search", "").strip()
            if not query:
                return {"reaction": reaction, "reply": answer.get("reply", "")}

        # A search he chose himself about someone in the chat ("what did kari say last week?") would
        # find nothing on the web, however the prompt asks him not to: don't send it. (A search someone
        # asked for with "search:" or "wiki:" always goes, in case a friend shares a famous name.)
        about_us = [name for name in self.names.values() if re.search(rf"\b{re.escape(name)}\b", query, re.IGNORECASE)]
        if about_us and not forced:
            log(f"Not searching {query!r}: it's about {', '.join(about_us)}, in the chat.")
            results = "(Not searched: the web knows nothing about the people in this chat. Answer from the messages you can see.)"
        else:
            results = self.search(query, wiki_only)

        # The results go into the conversation as a note, and he's asked again: this time he can
        # only answer (the schema has no "search"), so he can't keep searching.
        conversation.append({"role": "user", "content": (
            f"[{'Wikipedia' if wiki_only else 'Web'} search for \"{query}\"]\n{results}\n\n"
            "[Now answer the conversation above with this. If a source helps, put its link in your reply.]"
        )})
        answer = self.complete(conversation, ANSWER_SCHEMA)
        return {"reaction": answer.get("reaction", ""), "reply": answer.get("reply", "")}

    def ask(self, conversation, schema=None, max_tokens=MAX_ANSWER_TOKENS, temperature=0.7):
        """The model's answer (text) to a conversation in the OpenAI shape llama-server uses: Claude's
        when CHATTUS_MODEL is set, otherwise the local model's. With `schema`, the answer is JSON of
        that shape. Blocking."""
        if self.claude:
            system, messages = for_claude(conversation)
            output_config = {"effort": "low"}  # chat: quick and short, no deep thinking
            if schema:
                output_config["format"] = {"type": "json_schema", "schema": claude_schema(schema)}
            response = self.claude.messages.create(
                model=self.claude_model, max_tokens=CLAUDE_MAX_TOKENS, system=system, messages=messages,
                output_config=output_config,
            )  # (no temperature: Claude's newest models only take their default)
            return next((block.text for block in response.content if block.type == "text"), "")

        request = {"messages": conversation, "max_tokens": max_tokens, "temperature": temperature}
        if schema:
            request["response_format"] = {"type": "json_schema", "json_schema": {"schema": schema}}
        answer, _ = post_json(f"{self.llama_url}/v1/chat/completions", request,
                              {"Authorization": f"Bearer {self.llama_key}"})
        return answer["choices"][0]["message"]["content"] or ""

    def complete(self, conversation, schema):
        """Ask the model, in the JSON shape `schema`, and read its answer. Blocking."""
        content = self.ask(conversation, schema)
        try:
            parsed = json.loads(content)
            # Texts as texts (the poll stays an object, {"question", "options"})
            return {key: value if isinstance(value, dict) else str(value) for key, value in parsed.items()}
        except (ValueError, AttributeError):  # cut off by max_tokens, say: use what's there as text
            return {"reply": content}

    def search(self, query, wiki_only=False):
        """Search results as text for the model (or a note saying why there are none). With Claude,
        Claude's own web search; with the local model, Exa. Wikipedia when those fail, or straight
        away with wiki_only ("wiki: ..."). At most MAX_SEARCHES_PER_DAY a day. Blocking."""
        today = date.today()
        if searches_today["day"] != today:
            searches_today.update(day=today, count=0)
        if searches_today["count"] >= MAX_SEARCHES_PER_DAY:
            log(f"Not searching {query!r}: the daily limit is used up.")
            return "(No results: searching is used up for today. Say you can't look it up until tomorrow.)"
        searches_today["count"] += 1

        if not wiki_only and self.claude:
            try:
                results = self.claude_search(query)
                log(f"Searched the web with Claude for {query!r}.")
                return results
            except Exception as error:  # (its search down, say: try Wikipedia)
                log(f"Claude didn't search {query!r} ({error!r:.200}); trying Wikipedia.")
        elif not wiki_only:
            try:
                results = exa_search(query, self.exa_key)
                log(f"Searched Exa for {query!r}.")
                return results
            except Exception as error:  # its free limit (SearchRefused), or it's down: try Wikipedia
                log(f"Exa didn't search {query!r} ({error!r:.100}); trying Wikipedia.")
        try:
            results = wikipedia_search(query)
            log(f"Searched Wikipedia for {query!r}.")
            return results or "(Wikipedia found nothing. Say you couldn't find it.)"
        except Exception as error:
            log(f"Wikipedia didn't search {query!r} either: {error!r}")
            return "(The search didn't work. Say you couldn't look it up right now.)"

    def claude_search(self, query):
        """Search the web with Claude's own search tool (Anthropic runs the searches): a separate,
        small request, so the search's sources can't clash with the JSON shape of his answers.
        What it found, as text with links, for the model to answer from. Blocking."""
        response = self.claude.messages.create(
            model=self.claude_model, max_tokens=CLAUDE_MAX_TOKENS, output_config={"effort": "low"},
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],  # (Haiku's version)
            messages=[{"role": "user", "content": (
                f"Search the web for: {query}\n\nThen write down, in a few sentences, what you found that "
                "answers it. Only facts from the results, with the link of the page each one came from."
            )}],
        )
        found = "\n".join(block.text for block in response.content if block.type == "text").strip()
        # The pages it searched, in case the summary has no links of its own
        pages = [f"{result.title}: {result.url}" for block in response.content
                 if block.type == "web_search_tool_result" and isinstance(block.content, list)
                 for result in block.content][:SEARCH_RESULTS]
        if not found and not pages:
            return "(The search found nothing. Say you couldn't find it.)"
        return found + ("\n\nPages:\n" + "\n".join(pages) if pages else "")

    def claude_read(self, url, question):
        """What a page says that matters for the question, read with Claude's own web fetch tool
        (Anthropic's servers fetch it, not this PC, and only addresses that are in the request).
        A separate, small request, like claude_search. Blocking."""
        try:
            response = self.claude.messages.create(
                model=self.claude_model, max_tokens=CLAUDE_MAX_TOKENS, output_config={"effort": "low"},
                tools=[{"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 1,
                        "max_content_tokens": READ_PAGE_TOKENS}],  # (Haiku's version)
                messages=[{"role": "user", "content": (
                    f"Read this page: {url}\n\nThen write down what it says that matters for this question from a "
                    f"chat: \"{question}\". Keep the important details (names, numbers, steps). If the page can't "
                    "be read, say so."
                )}],
            )
            text = "\n".join(block.text for block in response.content if block.type == "text").strip()
            log(f"Read {url} with Claude.")
            return text or "(The page couldn't be read. Say so.)"
        except Exception as error:
            log(f"Couldn't read {url}: {error!r:.200}")
            return "(The page couldn't be read right now. Say so.)"

    def reaction_code(self, reaction):
        """The model's reaction as the server wants it, or None if the server wouldn't accept it:
        an emoji from emoji.json as it is, a custom emoji's :name: as "custom:17"."""
        reaction = reaction.strip()
        if not reaction:
            return None
        if reaction in self.allowed_emoji:
            return reaction
        # The same emoji with or without the invisible "show as emoji" mark (U+FE0F) after it:
        # models and emoji lists don't always agree on it.
        for variant in (reaction + "️", reaction.replace("️", "")):
            if variant in self.allowed_emoji:
                return variant
        match = re.fullmatch(r":?([A-Za-z0-9_]{2,32}):?", reaction)
        if match:
            for emoji_id, name in self.emoji.items():
                if name.lower() == match[1].lower():
                    return f"custom:{emoji_id}"
        return None  # something else: no reaction

    def poll_text(self, poll):
        """The poll's message and how many options it has, like "📊 **Friday dinner?**\\n1️⃣ Pizza\\n2️⃣ Sushi".
        With fewer than two options, a message saying how to make one (and 0 options)."""
        question = str(poll.get("question", "")).strip() or "Poll"
        options = [str(option).strip() for option in poll.get("options", []) if str(option).strip()]
        options = options[:len(POLL_NUMBERS)]
        if len(options) < 2:
            return "📊 A poll needs at least two options, like \"poll: Friday dinner? pizza, sushi, tacos\".", 0
        lines = [f"📊 **{question}**"] + [f"{number} {option}" for number, option in zip(POLL_NUMBERS, options)]
        lines.append("*Vote with the numbers below (my own votes don't count).*")
        return "\n".join(lines), len(options)

    def clean_answer(self, text):
        text = text.strip()
        # In case it copies the "[time] name: text" pattern of the messages it reads.
        text = re.sub(r"^\s*(\[(\d{1,2} \w{3} )?\d{1,2}:\d{2}\]\s*)?(Chattus:\s*)?", "", text)
        # Never ping everyone: "@everyone" and "@here" lose their @ (the server only expands "@name").
        text = re.sub(r"@(everyone|here)\b", r"\1", text, flags=re.IGNORECASE)
        return text[:MAX_TEXT_LENGTH].strip()


async def main():
    parser = argparse.ArgumentParser(description="Chattus, the chat's AI bot.")
    parser.add_argument("--chat", default="http://127.0.0.1:8000", help="the chat server (default: the real one)")
    parser.add_argument("--llama", default="http://127.0.0.1:8080", help="llama-server (default: on this PC)")
    parser.add_argument("--env", default=".env", help="the env file with CHATTUS_PASSWORD and LLAMA_API_KEY")
    args = parser.parse_args()

    settings = read_env(args.env)
    # CHATTUS_MODEL (like claude-haiku-5-5): Claude through Anthropic's API instead of the local model.
    claude_model = settings.get("CHATTUS_MODEL") or None
    for name in ("CHATTUS_PASSWORD", "ANTHROPIC_API_KEY" if claude_model else "LLAMA_API_KEY"):
        if not settings.get(name):
            raise SystemExit(f"{name} is missing in {args.env} (see the README, 'Optional: an AI bot').")
    log(f"Using {claude_model or 'the local model (llama-server)'}.")

    while True:  # forever: when the chat restarts (every deploy), the connection drops; log in again
        bot = Chattus(args.chat, args.llama, settings["CHATTUS_PASSWORD"], settings.get("LLAMA_API_KEY"),
                      settings.get("EXA_API_KEY") or None, claude_model, settings.get("ANTHROPIC_API_KEY"))
        try:
            await bot.run()
            log("The connection closed.")
        except Exception as error:
            log(f"Disconnected: {error!r}")
        await asyncio.sleep(10)


if __name__ == "__main__":
    asyncio.run(main())
