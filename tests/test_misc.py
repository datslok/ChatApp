"""Everything else: the pages and where they send you, "welcome", push subscriptions, link previews
(never of addresses inside the network), GIFs without a key, the phone app's updates, and files that
must never be reachable."""
from conftest import VAPID_PUBLIC_KEY, Client, unique


# ----- Pages

def test_the_chat_needs_a_login(person):
    stranger = Client()
    assert stranger.get("/", follow=False).headers["location"] == "/login"
    assert stranger.get("/login").status == 200
    assert person.get("/").status == 200
    assert person.get("/login", follow=False).headers["location"] == "/"  # already logged in


def test_an_unverified_account_goes_to_the_verify_page(server):
    person, _ = server.register(unique("waiting"))
    assert person.get("/", follow=False).headers["location"] == "/verify-email"
    assert person.get("/login", follow=False).headers["location"] == "/verify-email"


def test_public_pages(server):
    stranger = Client()
    for path in ["/welcome", "/download", "/reset", "/verify-email", "/manifest.json", "/sw.js", "/favicon.ico",
                 "/emoji.json", "/changelog.json", "/static/js/core.js", "/static/css/chat.css"]:
        assert stranger.get(path).status == 200, path
    landing = stranger.get("/welcome").body.decode()
    assert "{{CHAT}}" not in landing and "http://127.0.0.1:8011" in landing


def test_the_page_files_are_always_checked_for_changes(server):
    for path in ["/static/js/core.js", "/static/css/chat.css", "/changelog.json", "/sw.js"]:
        assert Client().get(path).headers["Cache-Control"] == "no-cache", path


def test_nothing_outside_static_is_reachable(server):
    stranger = Client()
    for path in ["/static/../server.py", "/static/js/../../server.py", "/static/js/..%2F..%2Fserver.py",
                 "/releases/.env", "/releases/..%2F.env", "/seasonal/..%2F.env", "/rnnoise-0.4.1/..%2F..%2Fserver.py",
                 "/app-update/assets/..%2Fserver.py", "/server.py", "/.env", "/chat.db"]:
        assert stranger.get(path).status == 404, path


def test_welcome_has_what_the_pages_need(person):
    with person.connect() as ws:
        welcome = ws.wait_for("welcome")
    assert welcome["id"] == person.id and welcome["max_text_length"] == 2000
    assert welcome["limits"]["custom_emoji"] == 24 and welcome["limits"]["group_size"] == 10
    assert welcome["vapid_public_key"] == VAPID_PUBLIC_KEY
    assert welcome["phone_push"] is False  # no Firebase key in tests
    assert len(welcome["page_version"]) == 16


def test_the_seasonal_video_needs_a_login_and_a_known_name(person):
    assert Client().get("/seasonal/halloween.mp4").status == 404
    assert person.get("/seasonal/secret.mp4").status == 404


# ----- Push

def test_push_subscriptions_only_at_known_push_services(person):
    good = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "p256dh": "key", "auth": "auth"}
    assert person.post("/push/subscribe", good).status == 200
    for endpoint in ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://evil.example/fcm.googleapis.com",
                     "https://fcm.googleapis.com.evil.example/x"]:
        assert person.post("/push/subscribe", {**good, "endpoint": endpoint}).status == 400, endpoint
    assert person.post("/push/subscribe", {**good, "p256dh": ""}).status == 400
    assert person.post("/push/mute", {"endpoint": good["endpoint"], "until": 9e9}).status == 200
    assert person.post("/push/unsubscribe", {"endpoint": good["endpoint"]}).status == 200
    assert Client().post("/push/subscribe", good).status == 401


def test_the_phone_push_needs_firebase(person):
    assert person.post("/push/fcm", {"token": "a" * 100}).status == 400  # not set up in tests


# ----- Link previews

def test_no_previews_of_addresses_inside_the_network(server, channel):
    """Against SSRF: the server never fetches its own or the network's addresses for a preview."""
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        for url in ["http://127.0.0.1:8011/login", "http://localhost/", "http://10.0.0.1/", "http://[::1]/",
                    "file:///etc/passwd", "http://169.254.169.254/latest/meta-data/"]:
            ws.say(f"see {url}")
        ws.nothing("preview", timeout=3)


def test_preview_pictures_need_a_login(server):
    assert Client().get("/previews/anything.webp").status == 404


# ----- GIFs

def test_gifs_without_a_key(person):
    assert person.get("/gifs/search?q=cat").status == 503
    assert person.post("/gifs/send", {"id": "abc"}).status == 503
    assert Client().get("/gifs/search?q=cat").status == 401


# ----- The phone app's updates

def test_app_update_requests_are_checked(server):
    assert Client().get("/app-update").status == 400
    no_update = Client().get("/app-update", headers={"expo-platform": "android", "expo-runtime-version": "0.0.1"})
    assert no_update.status == 204 and no_update.headers["expo-protocol-version"] == "1"
    assert Client().get("/app-update", headers={"expo-platform": "ios", "expo-runtime-version": "1.0.0"}).status == 400
    assert Client().get("/app-update/assets/not-a-hash.png").status == 404
