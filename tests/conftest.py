"""The test suite's shared parts: a real server to test, and people to use it with.

pytest reads this file by itself before the tests (it's where "fixtures" go: setup code that tests ask
for by naming it as an argument). The tests only ever talk to the server from the outside, like the web
page and the phone app do: HTTP requests and WebSocket messages. They never import server.py, so they
keep working however its code is arranged inside.

    def test_something(server, owner):
        kari = server.person("kari")          # a new account: invited, registered, email verified
        reply = kari.post("/friends/request", {"user_id": owner.id})
        assert reply.status == 200
        with kari.connect() as ws:            # the WebSocket, logged in as kari
            ws.send(type="join", channel="general")
            history = ws.wait_for("history")
"""
import http.cookiejar
import itertools
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from websockets.sync.client import connect as ws_connect

REPO = Path(__file__).resolve().parent.parent  # the folder with server.py
PORT = 8011  # not 8000 (the real site) or 8001 (start.ps1), so the tests can run beside both
BASE = f"http://127.0.0.1:{PORT}"
PASSWORD = "test-password-1"

# Settings the test server must never get from this PC's environment: real keys would make it reach
# outside services (Firebase, GIPHY, Anthropic, a mail server) during the tests.
SECRETS = {
    "GIPHY_API_KEY", "ANTHROPIC_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "LANDING_HOST",
    "CHATTUS_PASSWORD", "LLAMA_API_KEY", "EXA_API_KEY", "SECURE_COOKIES",
}

# A development VAPID key pair (dev.env's: no secret), so push subscriptions can be tested.
VAPID_PUBLIC_KEY = "BOogJTxNz-llSaIE5Wny5wRpN2pBhC93Sv8Xkixb8zSpfGkApXceEsNNDoDXT0BWLhWWTf_aC-dwn5syWC_Lb-Y"
VAPID_PRIVATE_KEY = "hpV7VEzcBT97TV5LrXfnMuY2S3Sd39Q4l2uBZkp7tlE"

_numbers = itertools.count(1)  # for unique names: kari1, kari2, ...


def unique(prefix):
    """A name no other test uses (the whole run shares one database)."""
    return f"{prefix}{next(_numbers)}"


class Reply:
    """An HTTP answer: status, the body as JSON (or None), the raw body, the headers."""

    def __init__(self, status, body, headers):
        self.status = status
        self.body = body
        self.headers = headers
        try:
            self.json = json.loads(body)
        except ValueError:
            self.json = None

    @property
    def detail(self):
        """FastAPI's error message ({"detail": "..."}), for asserts about refusals."""
        return (self.json or {}).get("detail") if isinstance(self.json, dict) else None

    def __repr__(self):
        return f"<Reply {self.status} {self.body[:200]!r}>"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Leaves redirects as they are, so a test can look at where one points."""

    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    """HTTP with its own cookies, like one browser. Never raises for 4xx/5xx: tests check .status."""

    def __init__(self, ip="127.0.0.1"):
        self.cookies = http.cookiejar.CookieJar()
        self.ip = ip  # sent as Cloudflare's header: the server's per-visitor limits count by it

    def request(self, method, path, body=None, raw=None, content_type=None, headers=None, follow=True):
        data, kind = None, None
        if raw is not None:
            data, kind = raw, content_type or "application/octet-stream"
        elif body is not None:
            data, kind = json.dumps(body).encode(), "application/json"
        all_headers = {"cf-connecting-ip": self.ip, **(headers or {})}
        if kind:
            all_headers["Content-Type"] = kind
        request = urllib.request.Request(BASE + path, data=data, method=method, headers=all_headers)
        handlers = [urllib.request.HTTPCookieProcessor(self.cookies)]
        if not follow:
            handlers.append(NoRedirect())
        opener = urllib.request.build_opener(*handlers)
        try:
            with opener.open(request, timeout=30) as response:
                return Reply(response.status, response.read(), response.headers)
        except urllib.error.HTTPError as error:  # 4xx, 5xx, and redirects when not following
            return Reply(error.code, error.read(), error.headers)

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, body=None, **kwargs):
        return self.request("POST", path, body=body, **kwargs)

    def delete(self, path, **kwargs):
        return self.request("DELETE", path, **kwargs)

    def cookie(self, name):
        return next((c.value for c in self.cookies if c.name == name), None)

    def connect(self):
        """The chat's WebSocket with this client's login cookie (use it in a `with` block)."""
        cookie = "; ".join(f"{c.name}={c.value}" for c in self.cookies)
        return Socket(ws_connect(f"ws://127.0.0.1:{PORT}/ws", additional_headers={"Cookie": cookie}, max_size=None))


class Person(Client):
    """A logged-in, verified account (made by Server.person)."""

    def __init__(self, name, email, ip):
        super().__init__(ip)
        self.name = name
        self.email = email
        self.id = None


class Socket:
    """One WebSocket connection. Messages the server sends are kept in arrival order; wait_for takes the
    first one of a type (skipping, but keeping, the others), so a test can ask in any order."""

    def __init__(self, connection):
        self.connection = connection
        self.inbox = []

    def __enter__(self):
        self.connection.__enter__()  # (websockets wants its connections used in a `with` too)
        return self

    def __exit__(self, *details):
        self.connection.__exit__(*details)

    def close(self):
        self.connection.close()

    def send(self, **data):
        self.connection.send(json.dumps(data))

    def _take(self, kind, where):
        for index, message in enumerate(self.inbox):
            if message.get("type") == kind and where(message):
                return self.inbox.pop(index)
        return None

    def wait_for(self, kind, where=lambda message: True, timeout=5):
        """The first message of this type (and matching `where`) that came or comes within `timeout`."""
        found = self._take(kind, where)
        deadline = time.monotonic() + timeout
        while found is None:
            left = deadline - time.monotonic()
            if left <= 0:
                types = [message.get("type") for message in self.inbox]
                raise AssertionError(f"No {kind!r} within {timeout} s (got: {types})")
            try:
                self.inbox.append(json.loads(self.connection.recv(timeout=left)))
            except TimeoutError:
                continue
            found = self._take(kind, where)
        return found

    def nothing(self, kind, where=lambda message: True, timeout=0.7):
        """Asserts no such message comes within `timeout` (for refusals the server answers with silence)."""
        try:
            message = self.wait_for(kind, where, timeout)
        except AssertionError:
            return
        raise AssertionError(f"Didn't expect {message}")

    def drain(self, timeout=0.3):
        """Forget everything received so far (and what's still arriving): a clean start."""
        end = time.monotonic() + timeout
        while (left := end - time.monotonic()) > 0:
            try:
                self.connection.recv(timeout=left)
            except TimeoutError:
                break
        self.inbox.clear()

    def join(self, channel):
        """Open a chat, like clicking it: answers with its "history" message."""
        self.send(type="join", channel=channel)
        return self.wait_for("history", lambda message: message["channel"] == channel)

    def say(self, text, **extra):
        """Send a message in the chat we're in, and return it as the server sent it back."""
        self.send(type="message", text=text, **extra)
        return self.wait_for("message", lambda message: message["text"] == text or extra.get("file") is not None)


class Server:
    """The running test server: makes people, and reads the emails it would have sent."""

    def __init__(self, log_path, work=None):
        self.log_path = log_path
        self.work = work  # the temporary folder with its database and uploads
        self.owner = None

    def log(self):
        return self.log_path.read_text(encoding="utf-8", errors="replace")

    def email_link(self, address, path, timeout=5):
        """The newest link to `path` (like "/verify") in an email to this address. Without SMTP_HOST the
        server prints each email instead of sending it (server.py, send_email); emails go out in the
        background after the answer, so this waits a moment for it."""
        deadline = time.monotonic() + timeout
        while True:
            links = []
            for email in self.log().split("----- EMAIL")[1:]:
                if f"To: {address}\n" in email:
                    links += re.findall(re.escape(BASE + path) + r"\?token=[\w-]+", email)
            if links:
                return links[-1][len(BASE):]
            if time.monotonic() > deadline:
                raise AssertionError(f"No email to {address} with a {path} link")
            time.sleep(0.1)

    def invite(self):
        """A fresh invite code from the owner. (At the limit of 10 open ones, left over from tests that
        didn't use theirs, those are cancelled first.)"""
        reply = self.owner.post("/invites")
        if reply.status == 400:
            for invite in self.owner.get("/invites").json["invites"]:
                self.owner.post(f"/invites/{invite['code']}/cancel")
            reply = self.owner.post("/invites")
        assert reply.status == 200, reply
        return reply.json["invites"][0]["code"]

    def register(self, name, invite=None, email=None, ip=None):
        """A new account up to its verification email (not verified yet): (person, reply)."""
        ip = ip or f"10.0.{next(_numbers) % 250}.{next(_numbers) % 250}"
        person = Person(name, email or f"{name.lower()}@example.com", ip)
        reply = person.post("/register", {
            "username": name, "password": PASSWORD, "email": person.email,
            "invite": self.invite() if invite is None else invite,
        })
        return person, reply

    def person(self, prefix="user"):
        """A new account that's ready to use: invited by the owner, registered, email verified."""
        person, reply = self.register(unique(prefix))
        assert reply.status == 200, reply
        verify(self, person)
        return person


def verify(server, person):
    """Click the link in the verification email, and learn the account's id."""
    reply = person.get(server.email_link(person.email, "/verify"))
    assert reply.status == 200, reply
    status = person.get("/verify/status").json
    assert status["verified"], status
    with person.connect() as ws:
        person.id = ws.wait_for("welcome")["id"]


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    """One server for the whole run, with its own empty database and uploads in a temporary folder.
    The first account (the owner, and admin) is made at once, as on a new server; it invites everyone else."""
    work = tmp_path_factory.mktemp("server")
    env = {name: value for name, value in os.environ.items() if name not in SECRETS}
    env.update({
        "DATABASE_FILE": str(work / "test.db"),
        "UPLOAD_DIR": str(work / "uploads"),
        "PUBLIC_URL": BASE,
        "REQUIRE_INVITE": "1",  # like the real site: invites are tested too
        "FIREBASE_KEY_FILE": str(work / "no-firebase-key.json"),  # (this PC has a real one in the repo folder)
        "LIVEKIT_URL": "ws://127.0.0.1:7999",  # tokens are made without a LiveKit server running
        "LIVEKIT_API_KEY": "testkey",
        "LIVEKIT_API_SECRET": "test-secret-that-is-long-enough-for-hs256",
        "VAPID_PUBLIC_KEY": VAPID_PUBLIC_KEY,
        "VAPID_PRIVATE_KEY": VAPID_PRIVATE_KEY,
        "PYTHONUNBUFFERED": "1",  # every print reaches the log at once (the emails are read from it)
        "PYTHONIOENCODING": "utf-8",
    })
    log_path = work / "server.log"
    with open(log_path, "w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", str(PORT)],
            cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            started = Server(log_path, work)
            deadline = time.monotonic() + 60
            while not _up():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("The test server didn't start:\n" + started.log())
                time.sleep(0.2)
            # The owner: the first account needs no invite.
            owner = Person("owner", "owner@example.com", "10.255.0.1")
            reply = owner.post("/register", {"username": "owner", "password": PASSWORD, "email": owner.email})
            assert reply.status == 200, reply
            verify(started, owner)
            started.owner = owner
            yield started
        finally:
            process.terminate()
            process.wait(timeout=10)


def _up():
    """Is anything answering on the port yet?"""
    try:
        urllib.request.urlopen(BASE + "/login", timeout=1)
        return True
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False


@pytest.fixture(scope="session")
def owner(server):
    """The first account: owner and admin."""
    return server.owner


@pytest.fixture(scope="session")
def bot(server):
    """A bot account, like Chattus (users.is_bot): made by tools/make_bot.py in the test database, as on a
    real server, and logged in with the password it writes into its env file."""
    env_file = server.work / "bot.env"
    subprocess.run(
        [sys.executable, "tools/make_bot.py", "--name", "TestBot", "--db", str(server.work / "test.db"),
         "--uploads", str(server.work / "uploads"), "--env", str(env_file)],
        cwd=REPO, check=True, capture_output=True,
    )
    password = re.search(r"CHATTUS_PASSWORD=(\S+)", env_file.read_text(encoding="utf-8"))[1]
    testbot = Person("TestBot", None, "10.254.0.1")
    reply = testbot.post("/login", {"username": "TestBot", "password": password})
    assert reply.status == 200, reply
    with testbot.connect() as ws:
        testbot.id = ws.wait_for("welcome")["id"]
    return testbot


@pytest.fixture
def person(server):
    """A fresh account for this test."""
    return server.person()


@pytest.fixture
def channel(owner):
    """A fresh channel for this test (deleted after it: there may be at most 50)."""
    reply = owner.post("/channels", {"name": unique("test-")})
    assert reply.status == 200, reply
    yield reply.json["key"]
    owner.post(f"/channels/{reply.json['key']}/delete")


@pytest.fixture
def friends(server):
    """Two new people who are friends, and their DM's key: (a, b, dm)."""
    a, b = server.person("ann"), server.person("ben")
    befriend(a, b)
    return a, b, dm_key(a, b)


def befriend(a, b):
    """Make two people friends (a asks, b accepts)."""
    assert a.post("/friends/request", {"user_id": b.id}).status == 200
    reply = b.post("/friends/accept", {"user_id": a.id})
    assert reply.status == 200, reply


def dm_key(a, b):
    """The DM's channel key for two people: "dm:<smaller id>:<bigger id>"."""
    return f"dm:{min(a.id, b.id)}:{max(a.id, b.id)}"
