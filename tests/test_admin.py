"""Admins and the owner: making admins, banning (who may ban whom, what a ban does), everyone's invites,
and the bug report inbox."""
from conftest import PASSWORD, Client


def make_admin(owner, person):
    reply = owner.post("/admin/admins", {"user_id": person.id, "admin": True})
    assert reply.status == 200, reply


def user_ids(ws):
    """The ids in the next "users" list (everyone the chat shows)."""
    return {user["id"] for user in ws.wait_for("users")["users"]}


# ----- Admins

def test_only_the_owner_makes_admins(server, owner):
    admin, other = server.person("admin"), server.person("other")
    make_admin(owner, admin)
    refused = admin.post("/admin/admins", {"user_id": other.id, "admin": True})
    assert refused.status == 403
    with other.connect() as ws:
        users = {user["id"]: user for user in ws.wait_for("users")["users"]}
    assert users[admin.id]["admin"] is True and users[other.id]["admin"] is False


def test_admin_can_be_taken_away(server, owner):
    admin = server.person("former")
    make_admin(owner, admin)
    assert admin.get("/feedback").status == 200
    owner.post("/admin/admins", {"user_id": admin.id, "admin": False})
    assert admin.get("/feedback").status == 403


def test_the_owner_stays_an_admin(owner):
    assert owner.post("/admin/admins", {"user_id": owner.id, "admin": False}).status == 400


def test_admin_pages_are_for_admins_only(person):
    for path in ["/feedback", "/admin/bans", "/admin/invites"]:
        assert person.get(path).status == 403, path
    assert Client().get("/feedback").status == 401
    assert person.post("/admin/ban", {"user_id": 1}).status == 403


# ----- Bans

def test_a_ban_logs_out_and_hides_the_person(server, owner):
    spammer = server.person("spammer")
    with owner.connect() as watching, spammer.connect() as theirs:
        theirs.wait_for("welcome")
        watching.drain()
        reply = owner.post("/admin/ban", {"user_id": spammer.id, "days": 7, "reason": "spam"})
        assert reply.status == 200
        assert any(ban["user_id"] == spammer.id and ban["reason"] == "spam" for ban in reply.json["bans"])
        # Out of everyone's lists, and their page is closed.
        assert spammer.id not in user_ids(watching)
        try:
            theirs.wait_for("never", timeout=2)
        except Exception as error:
            assert "No 'never'" not in str(error), "their WebSocket stayed open"
    assert spammer.get("/me").status == 401
    # Logging in again says why (after checking the password).
    login = Client().post("/login", {"username": spammer.name, "password": PASSWORD})
    assert login.status == 403 and "banned until" in login.detail and "spam" in login.detail


def test_unbanning(server, owner):
    banned = server.person("banned")
    owner.post("/admin/ban", {"user_id": banned.id})  # for good
    login = Client().post("/login", {"username": banned.name, "password": PASSWORD})
    assert login.status == 403 and login.detail.startswith("This account is banned.")
    reply = owner.post("/admin/unban", {"user_id": banned.id})
    assert all(ban["user_id"] != banned.id for ban in reply.json["bans"])
    assert Client().post("/login", {"username": banned.name, "password": PASSWORD}).status == 200


def test_who_may_ban_whom(server, owner):
    admin, other_admin, person = server.person("mod"), server.person("mod"), server.person("member")
    make_admin(owner, admin)
    make_admin(owner, other_admin)
    assert admin.post("/admin/ban", {"user_id": owner.id}).status == 403  # never the owner
    assert admin.post("/admin/ban", {"user_id": admin.id}).status == 403  # nor yourself
    assert admin.post("/admin/ban", {"user_id": other_admin.id}).status == 403  # admins: only the owner
    assert admin.post("/admin/ban", {"user_id": person.id, "days": 3}).status == 400  # 1, 7 or 30 days
    assert admin.post("/admin/ban", {"user_id": person.id, "days": 1}).status == 200
    # The owner may ban an admin, who then isn't one any more.
    assert owner.post("/admin/ban", {"user_id": other_admin.id, "days": 1}).status == 200
    owner.post("/admin/unban", {"user_id": other_admin.id})
    fresh = Client()
    fresh.post("/login", {"username": other_admin.name, "password": PASSWORD})
    assert fresh.get("/feedback").status == 403


def test_a_banned_person_cant_be_made_admin(server, owner):
    banned = server.person("nope")
    owner.post("/admin/ban", {"user_id": banned.id, "days": 30})
    assert owner.post("/admin/admins", {"user_id": banned.id, "admin": True}).status == 400


def test_a_ban_cancels_their_open_invites(server, owner):
    inviter = server.person("inviter")
    code = inviter.post("/invites").json["invites"][0]["code"]
    owner.post("/admin/ban", {"user_id": inviter.id, "days": 1})
    assert Client().get(f"/invite-info?code={code}").json["valid"] is False


# ----- Everyone's invites

def test_admins_see_and_cancel_everyones_invites(server, owner):
    inviter = server.person("sharer")
    code = inviter.post("/invites").json["invites"][0]["code"]
    listing = owner.get("/admin/invites").json
    assert any(invite["code"] == code and invite["by"] == inviter.name for invite in listing["open"])
    owner.post(f"/admin/invites/{code}/cancel")
    assert Client().get(f"/invite-info?code={code}").json["valid"] is False


def test_who_joined_with_whose_invite(server, owner):
    newcomer = server.person("newcomer")  # invited by the owner
    joined = owner.get("/admin/invites").json["joined"]
    assert any(row["user_id"] == newcomer.id and row["invited_by"] == "owner" for row in joined)


# ----- Bug reports and ideas

def test_feedback_reaches_the_inbox(server, owner, person):
    assert person.post("/feedback", {"kind": "bug", "text": "the cat is too cute", "phone": True}).status == 200
    report = next(item for item in owner.get("/feedback").json if item["text"] == "the cat is too cute")
    assert report["user_id"] == person.id and report["kind"] == "bug" and not report["done"]
    assert report["user_agent"].startswith("ChatApp Android app")
    # It's emailed to the admins (printed here: no mail server).
    assert "the cat is too cute" in server.log()
    assert owner.post(f"/feedback/{report['id']}/done", {"done": True}).status == 200
    assert next(item for item in owner.get("/feedback").json if item["id"] == report["id"])["done"]
    assert owner.post("/feedback/999999/done", {"done": True}).status == 404


def test_feedback_is_checked(person):
    assert person.post("/feedback", {"kind": "rant", "text": "x"}).status == 400
    assert person.post("/feedback", {"kind": "idea", "text": "   "}).status == 400
    assert person.post("/feedback", {"kind": "idea", "text": "x" * 4001}).status == 400


def test_feedback_is_limited(person):
    answers = [person.post("/feedback", {"kind": "idea", "text": f"idea {n}"}).status for n in range(6)]
    assert answers == [200] * 5 + [429]
