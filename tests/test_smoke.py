"""The harness itself: the server starts, the owner exists, a new person can sign up and connect."""


def test_owner_is_admin_and_owner(owner):
    with owner.connect() as ws:
        welcome = ws.wait_for("welcome")
        users = ws.wait_for("users")
    assert welcome["username"] == "owner"
    me = next(user for user in users["users"] if user["id"] == owner.id)
    assert me["admin"] is True


def test_new_person_connects(server):
    kari = server.person("kari")
    with kari.connect() as ws:
        assert ws.wait_for("welcome")["username"] == kari.name
        assert any(channel["key"] == "general" for channel in ws.wait_for("channels")["channels"])
