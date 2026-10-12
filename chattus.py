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
import json
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from websockets.asyncio.client import connect  # the WebSocket library (installed with uvicorn[standard])

HOME = "chattus"           # his own channel: he answers every message there
CONTEXT_MESSAGES = 20      # how many of the latest messages the model reads
MAX_ANSWER_TOKENS = 400    # an emergency brake on length (the prompt asks for short answers)
MAX_TEXT_LENGTH = 2000     # the chat's own limit for a message (server.py)
MAX_AGE = timedelta(hours=1)  # older messages are never answered (after he was offline for a while)

SYSTEM_PROMPT = """You are Chattus, a friendly and helpful cat who lives in a small group chat of friends.
Write like a person in a chat: usually one to three short sentences, no headings or bullet lists.
Only write more when someone asks you to explain something in detail. Use at most one emoji in a message, often none.
Each message from the others starts with the sender's name, like "kari: hi". Don't start yours with your name.
If you don't know something, say so instead of making it up.
{where}
Right now it's {now}.

You answer with JSON: "reply" is your message, and "reaction" is one emoji to put under the message you're answering.
- Most of the time, react with nothing (""). Only react when it adds something, like 🎉 for good news or 😂 for a really good joke.
- When a reaction says it all (a thanks, a goodbye, an "ok"), react and leave "reply" empty ("").
- Questions and requests always get a reply.{custom}"""

# The shape every answer must have. llama-server turns it into grammar rules, so the model can't write
# anything else: always valid JSON with exactly these two texts (either can be empty).
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"reaction": {"type": "string"}, "reply": {"type": "string"}},
    "required": ["reaction", "reply"],
}
MAX_CUSTOM_EMOJI = 50  # how many of the chat's own emoji the prompt lists by name


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


class Chattus:
    def __init__(self, chat_url, llama_url, password, llama_key):
        self.chat_url = chat_url
        self.llama_url = llama_url
        self.password = password
        self.llama_key = llama_key
        self.cookie = None      # "session=..." after logging in
        self.websocket = None
        self.my_id = None
        self.names = {}         # user id -> username, for turning <@2> into @kari
        self.emoji = {}         # custom emoji id -> name, for turning <:17> into :pog:
        self.allowed_emoji = set()  # every emoji the server accepts as a reaction (static/emoji.json)
        self.channel = None     # the channel we've joined
        self.messages = {}      # channel -> its latest messages (from "history", then live ones)
        self.history_arrived = None  # a Future the reader completes when a joined channel's history comes
        self.queue = asyncio.Queue()  # channels to look at, one after the other
        self.queued = set()     # ... the same, to never queue one twice
        self.answered = set()   # ids of messages we've answered (so never twice, whatever the timing)

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
            try:
                async for raw in websocket:  # each message from the server, until it closes
                    await self.handle(json.loads(raw))
            finally:
                worker.cancel()

    async def send(self, data):
        await self.websocket.send(json.dumps(data))

    # ---------- What the server tells us ----------

    async def handle(self, data):
        kind = data.get("type")
        if kind == "welcome":
            self.my_id = data["id"]
        elif kind == "users":
            self.names = {user["id"]: user["name"] for user in data["users"]}
        elif kind == "custom_emoji":
            self.emoji = {emoji["id"]: emoji["name"] for emoji in data["emoji"]}
        elif kind == "friends":
            # Anyone may DM him: accept every friend request (DMs need a friendship).
            for user_id in data["incoming"]:
                await asyncio.to_thread(post_json, f"{self.chat_url}/friends/accept", {"user_id": user_id},
                                        {"Cookie": self.cookie})
                log(f"Accepted a friend request from {self.names.get(user_id, user_id)}.")
        elif kind == "history":
            self.messages[data["channel"]] = data["messages"]
            if self.history_arrived and not self.history_arrived.done():
                self.history_arrived.set_result(None)
        elif kind == "message":
            channel = data["channel"]
            self.messages.setdefault(channel, []).append(data)
            del self.messages[channel][:-50]  # keep the latest 50
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
        if message["user_id"] in (None, self.my_id) or message.get("kind") or not message["text"]:
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
                await self.answer(channel)
            except Exception as error:  # a broken answer must not stop the bot
                log(f"Couldn't answer in {channel}: {error!r}")

    async def join(self, channel):
        """Open a channel (like clicking on it) and wait for its history."""
        self.history_arrived = asyncio.get_running_loop().create_future()
        self.channel = channel
        await self.send({"type": "join", "channel": channel})
        try:
            await asyncio.wait_for(self.history_arrived, timeout=10)
        except TimeoutError:  # the server said nothing: not a channel we may join
            self.channel = None
            raise

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
            if self.should_answer(message, channel):
                target = message
                break
        if target is None:
            return
        self.answered.add(target["id"])

        log(f"Answering {target['name']} in {channel}: {target['text'][:80]!r}")
        typing = asyncio.create_task(self.keep_typing())
        try:
            reaction, text = await asyncio.to_thread(self.ask_model, channel, messages)
        finally:
            typing.cancel()

        reaction = self.reaction_code(reaction)
        mine = any(r["emoji"] == reaction and self.my_id in r["user_ids"] for r in target.get("reactions") or [])
        if reaction and not mine:  # (reacting again would take it away: reactions are a toggle)
            await self.send({"type": "react", "message_id": target["id"], "emoji": reaction})
        text = self.clean_answer(text)
        if not text:
            return  # just a reaction (or nothing at all)

        reply = {"type": "message", "text": text}
        # Shown as a reply when it isn't obvious what he's answering: always where he only answers
        # mentions, and in #chattus and his DMs when someone else wrote after that message.
        if not self.answers_everything(channel) or messages[-1] is not target:
            reply["reply_to"] = target["id"]
        await self.send(reply)
        # (Messages that came while he was thinking queued this channel again: handle() did that.)

    async def keep_typing(self):
        """'Chattus is typing…' while the model writes. The page forgets it after 3 quiet seconds."""
        while True:
            await self.send({"type": "typing"})
            await asyncio.sleep(2)

    # ---------- The model ----------

    def readable(self, text):
        """The chat's tokens as people write them: <@2> -> @kari, <@everyone> -> @everyone, <:17> -> :pog:."""
        text = re.sub(r"<@(\d+)>", lambda m: "@" + self.names.get(int(m[1]), "someone"), text)
        text = text.replace("<@everyone>", "@everyone")
        return re.sub(r"<:(\d+)>", lambda m: ":" + self.emoji.get(int(m[1]), "emoji") + ":", text)

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

    def ask_model(self, channel, messages):
        """The latest messages as a conversation for the model, and its answer: (reaction, reply).
        Blocking (run it in a thread)."""
        names = sorted(self.emoji.values(), key=str.lower)[:MAX_CUSTOM_EMOJI]
        custom = ("\nThe chat also has its own emoji, which you can use in your reply or as your reaction by writing "
                  "their name like this: " + ", ".join(f":{name}:" for name in names)) if names else ""
        conversation = [{
            "role": "system",
            "content": SYSTEM_PROMPT.format(where=self.where(channel), now=f"{datetime.now():%A %d %B %Y, %H:%M}",
                                            custom=custom),
        }]
        for message in messages[-CONTEXT_MESSAGES:]:
            if message.get("kind"):
                continue  # call notes ("a call started") aren't conversation
            text = self.readable(message["text"])
            if message["file"]:  # he can't see files (yet): just that there was one
                sent = "a picture" if message["file"]["image"] else f"a file: {message['file']['filename']}"
                text = (text + " " if text else "") + f"[sent {sent}]"
            if message["user_id"] == self.my_id:
                conversation.append({"role": "assistant", "content": text})
            else:
                replying = f"(replying to {message['reply']['name']}) " if (message.get("reply") or {}).get("name") else ""
                conversation.append({"role": "user", "content": f"{message['name']}: {replying}{text}"})

        answer, _ = post_json(
            f"{self.llama_url}/v1/chat/completions",
            {
                "messages": conversation, "max_tokens": MAX_ANSWER_TOKENS, "temperature": 0.7,
                "response_format": {"type": "json_schema", "json_schema": {"schema": ANSWER_SCHEMA}},
            },
            {"Authorization": f"Bearer {self.llama_key}"},
        )
        content = answer["choices"][0]["message"]["content"] or ""
        try:
            parsed = json.loads(content)
            return parsed["reaction"], parsed["reply"]
        except (ValueError, KeyError, TypeError):  # cut off by max_tokens, say: use what's there as text
            return "", content

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

    def clean_answer(self, text):
        text = text.strip()
        text = re.sub(r"^\s*Chattus:\s*", "", text)  # in case it copies the "name: text" pattern
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
    for name in ("CHATTUS_PASSWORD", "LLAMA_API_KEY"):
        if not settings.get(name):
            raise SystemExit(f"{name} is missing in {args.env} (see the README, 'Optional: an AI bot').")

    while True:  # forever: when the chat restarts (every deploy), the connection drops; log in again
        bot = Chattus(args.chat, args.llama, settings["CHATTUS_PASSWORD"], settings["LLAMA_API_KEY"])
        try:
            await bot.run()
            log("The connection closed.")
        except Exception as error:
            log(f"Disconnected: {error!r}")
        await asyncio.sleep(10)


if __name__ == "__main__":
    asyncio.run(main())
