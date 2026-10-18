"""Channels and roles: making, renaming, ordering and deleting channels; roles with colours and members;
private channels, limited roles (only their private channels, no Lounge) and hidden roles."""
import pytest
from conftest import unique


def channels_of(person):
    """The channel keys this person's sidebar shows, and whether it has the Lounge."""
    with person.connect() as ws:
        message = ws.wait_for("channels")
    return [item["key"] for item in message["channels"]], message["lounge"]


@pytest.fixture
def role(owner):
    """A fresh role for this test, its id (deleted after it: there may be at most 20)."""
    name = unique("Role")
    assert owner.post("/roles", {"name": name, "colour": "#3BA55C"}).status == 200
    with owner.connect() as ws:
        role_id = next(r["id"] for r in ws.wait_for("roles")["roles"] if r["name"] == name)
    yield role_id
    owner.post(f"/roles/{role_id}/delete")


def give(owner, role_id, person, member=True):
    reply = owner.post(f"/roles/{role_id}/members", {"user_id": person.id, "member": member})
    assert reply.status == 200, reply


# ----- Channels

def test_the_first_channels_exist(person):
    keys, lounge = channels_of(person)
    assert {"general", "memes", "chattus"} <= set(keys) and lounge is True


def test_making_renaming_and_deleting_a_channel(server, owner):
    person = server.person()
    with person.connect() as ws:
        ws.drain()
        key = owner.post("/channels", {"name": "  New   room  "}).json["key"]
        assert key.startswith("c:")
        made = ws.wait_for("channels")  # every page hears at once
        item = next(item for item in made["channels"] if item["key"] == key)
        assert item["name"] == "New room" and item["heading"] is False
        owner.post(f"/channels/{key}/rename", {"name": "Renamed"})
        renamed = ws.wait_for("channels")
        assert next(item for item in renamed["channels"] if item["key"] == key)["name"] == "Renamed"
        # Messages belong to the key, so they survive a rename.
        ws.join(key)
        ws.say("still here")
        owner.post(f"/channels/{key}/delete")
        assert key not in [item["key"] for item in ws.wait_for("channels")["channels"]]
    with person.connect() as ws:
        ws.send(type="join", channel=key)
        ws.nothing("history")


def test_only_admins_manage_channels(person, channel):
    assert person.post("/channels", {"name": "mine"}).status == 403
    assert person.post(f"/channels/{channel}/rename", {"name": "mine"}).status == 403
    assert person.post(f"/channels/{channel}/delete").status == 403
    assert person.post("/channels/order", {"keys": []}).status == 403


def test_channel_names_are_checked(owner):
    assert owner.post("/channels", {"name": "   "}).status == 400
    assert owner.post("/channels", {"name": "x" * 31}).status == 400
    assert owner.post("/channels/c:nope/rename", {"name": "x"}).status == 404


def test_headings(owner, person):
    key = owner.post("/channels", {"name": "Games", "heading": True}).json["key"]
    try:
        assert key.startswith("h:")
        with person.connect() as ws:
            ws.send(type="join", channel=key)  # nobody can open a heading
            ws.nothing("history")
        assert owner.post(f"/channels/{key}/access", {"private": True, "roles": []}).status == 400
    finally:
        owner.post(f"/channels/{key}/delete")


def test_reordering_needs_the_whole_list(owner, channel):
    keys = [item["key"] for item in owner.get("/channels").json]
    assert owner.post("/channels/order", {"keys": keys[:-1]}).status == 409
    new_order = [channel] + [key for key in keys if key != channel]
    assert owner.post("/channels/order", {"keys": new_order}).status == 200
    assert [item["key"] for item in owner.get("/channels").json] == new_order
    assert owner.post("/channels/order", {"keys": keys}).status == 200  # (back as it was)


def test_deleting_a_channel_deletes_its_messages(owner):
    key = owner.post("/channels", {"name": "temporary"}).json["key"]
    with owner.connect() as ws:
        ws.join(key)
        ws.say("gone soon")
    owner.post(f"/channels/{key}/delete")
    with owner.connect() as ws:
        ws.send(type="search", query="gone soon", channel=None)
        assert ws.wait_for("search_results")["results"] == []


# ----- Roles

def test_roles_reach_everyone_with_their_people(owner, person, role):
    give(owner, role, person)
    with person.connect() as ws:
        roles = ws.wait_for("roles")["roles"]
        users = {user["id"]: user for user in ws.wait_for("users")["users"]}
    assert any(r["id"] == role and r["colour"] == "#3ba55c" for r in roles)  # (colours stored in lowercase)
    assert role in users[person.id]["roles"]
    give(owner, role, person, member=False)
    with person.connect() as ws:
        assert role not in {user["id"]: user for user in ws.wait_for("users")["users"]}[person.id]["roles"]


def test_only_admins_manage_roles(person, role):
    assert person.post("/roles", {"name": "Mine", "colour": "#000000"}).status == 403
    assert person.post(f"/roles/{role}/edit", {"name": "Mine", "colour": "#000000"}).status == 403
    assert person.post(f"/roles/{role}/members", {"user_id": person.id, "member": True}).status == 403
    assert person.post(f"/roles/{role}/delete").status == 403


def test_roles_are_checked(owner, role):
    assert owner.post("/roles", {"name": "Bad", "colour": "red"}).status == 400
    assert owner.post("/roles", {"name": " ", "colour": "#000000"}).status == 400
    assert owner.post("/roles/999999/edit", {"name": "x", "colour": "#000000"}).status == 404
    assert owner.post(f"/roles/{role}/members", {"user_id": 999999, "member": True}).status == 404


def test_editing_and_ordering_roles(owner, role):
    assert owner.post(f"/roles/{role}/edit", {"name": "Renamed role", "colour": "#FF0000"}).status == 200
    with owner.connect() as ws:
        roles = ws.wait_for("roles")["roles"]
    assert next(r for r in roles if r["id"] == role)["name"] == "Renamed role"
    ids = [r["id"] for r in roles]
    assert owner.post("/roles/order", {"ids": ids[:-1]}).status == 409
    new_order = [role] + [i for i in ids if i != role]
    assert owner.post("/roles/order", {"ids": new_order}).status == 200
    with owner.connect() as ws:
        assert [r["id"] for r in ws.wait_for("roles")["roles"]] == new_order


# ----- Private channels

def test_a_private_channel_is_for_its_roles(server, owner, channel, role):
    member, outsider = server.person("member"), server.person("outsider")
    give(owner, role, member)
    assert owner.post(f"/channels/{channel}/access", {"private": True, "roles": [role]}).status == 200
    assert channel in channels_of(member)[0]
    assert channel not in channels_of(outsider)[0]
    with outsider.connect() as ws:
        ws.send(type="join", channel=channel)
        ws.nothing("history")
        ws.send(type="message", text="let me in", channel=channel, nonce="n")
        assert ws.wait_for("not_sent")
    # Its member list: everyone who sees it (the owner, and the role's people).
    with member.connect() as ws:
        item = next(item for item in ws.wait_for("channels")["channels"] if item["key"] == channel)
    assert set(item["members"]) >= {owner.id, member.id} and outsider.id not in item["members"]
    assert "roles" not in item  # (which roles: admins only)


def test_losing_the_role_closes_the_channel_at_once(server, owner, channel, role):
    member = server.person()
    give(owner, role, member)
    owner.post(f"/channels/{channel}/access", {"private": True, "roles": [role]})
    with member.connect() as ws:
        ws.join(channel)
        ws.drain()
        give(owner, role, member, member=False)
        assert channel not in [item["key"] for item in ws.wait_for("channels")["channels"]]
        ws.send(type="message", text="still here?")
        ws.nothing("message")


def test_a_private_channel_without_roles_is_the_owners_only(server, owner, channel):
    admin = server.person("admin")
    owner.post("/admin/admins", {"user_id": admin.id, "admin": True})
    owner.post(f"/channels/{channel}/access", {"private": True, "roles": []})
    assert channel in channels_of(owner)[0]
    assert channel not in channels_of(admin)[0]  # not even other admins (the user's wish)
    # ...who can't rename or delete it either: to them it doesn't exist.
    assert admin.post(f"/channels/{channel}/rename", {"name": "mine"}).status == 404
    assert admin.post(f"/channels/{channel}/delete").status == 404


def test_access_with_an_unknown_role_is_refused(owner, channel):
    assert owner.post(f"/channels/{channel}/access", {"private": True, "roles": [999999]}).status == 409


# ----- Limited roles

def test_a_limited_role_sees_only_its_private_channels(server, owner, channel, role):
    parent = server.person("parent")
    give(owner, role, parent)
    owner.post(f"/channels/{channel}/access", {"private": True, "roles": [role]})
    assert owner.post(f"/roles/{role}/limited", {"limited": True}).status == 200
    keys, lounge = channels_of(parent)
    assert keys == [channel] and lounge is False
    with parent.connect() as ws:
        ws.send(type="join", channel="general")
        ws.nothing("history")
        me = next(user for user in ws.wait_for("users")["users"] if user["id"] == parent.id)
    assert me["limited"] is True
    assert parent.get("/voice-token?room=lounge").status == 403


def test_admins_are_never_limited(server, owner, role):
    admin = server.person()
    owner.post("/admin/admins", {"user_id": admin.id, "admin": True})
    give(owner, role, admin)
    owner.post(f"/roles/{role}/limited", {"limited": True})
    keys, lounge = channels_of(admin)
    assert "general" in keys and lounge is True


# ----- Hidden roles

def test_a_hidden_role_is_known_only_to_admins(server, owner, role):
    member = server.person()
    give(owner, role, member)
    assert owner.post(f"/roles/{role}/hidden", {"hidden": True}).status == 200
    with member.connect() as ws:
        roles = ws.wait_for("roles")["roles"]
        users = {user["id"]: user for user in ws.wait_for("users")["users"]}
    assert role not in [r["id"] for r in roles] and role not in users[member.id]["roles"]
    with owner.connect() as ws:
        assert any(r["id"] == role and r["hidden"] for r in ws.wait_for("roles")["roles"])
        users = {user["id"]: user for user in ws.wait_for("users")["users"]}
    assert role in users[member.id]["roles"]
