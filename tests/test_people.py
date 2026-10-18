"""People: friends and requests, blocking, group DMs, muting chats, pinning DMs, statuses and activities,
the profile's status and bio, and appearance settings."""
from conftest import befriend, dm_key, unique


def friends_of(person):
    with person.connect() as ws:
        return ws.wait_for("friends")


def user_entry(ws, person):
    return next(user for user in ws.wait_for("users")["users"] if user["id"] == person.id)


# ----- Friends

def test_a_friend_request_and_accepting_it(server):
    a, b = server.person(), server.person()
    with b.connect() as ws_b:
        ws_b.drain()
        assert a.post("/friends/request", {"user_id": b.id}).status == 200
        assert ws_b.wait_for("friends")["incoming"] == [a.id]  # they hear at once
    assert friends_of(a)["outgoing"] == [b.id]
    assert b.post("/friends/accept", {"user_id": a.id}).status == 200
    assert friends_of(a)["friends"] == [b.id] and friends_of(b)["friends"] == [a.id]


def test_asking_back_counts_as_accepting(server):
    a, b = server.person(), server.person()
    a.post("/friends/request", {"user_id": b.id})
    b.post("/friends/request", {"user_id": a.id})
    assert friends_of(a)["friends"] == [b.id]


def test_only_the_asked_one_can_accept(server):
    a, b = server.person(), server.person()
    a.post("/friends/request", {"user_id": b.id})
    assert a.post("/friends/accept", {"user_id": b.id}).status == 400
    assert friends_of(a)["friends"] == []


def test_nonsense_friend_requests(person):
    assert person.post("/friends/request", {"user_id": person.id}).status == 400  # yourself
    assert person.post("/friends/request", {"user_id": 999999}).status == 400  # nobody


def test_declining_cancelling_and_unfriending(server):
    a, b = server.person(), server.person()
    a.post("/friends/request", {"user_id": b.id})
    b.post("/friends/remove", {"user_id": a.id})  # declined
    assert friends_of(a)["outgoing"] == []
    befriend(a, b)
    a.post("/friends/remove", {"user_id": b.id})  # unfriended
    assert friends_of(b)["friends"] == []


# ----- Blocking

def test_blocking_ends_the_friendship_and_stops_requests(server):
    a, b = server.person(), server.person()
    befriend(a, b)
    assert a.post("/friends/block", {"user_id": b.id}).status == 200
    assert friends_of(b)["friends"] == []
    with a.connect() as ws:
        assert ws.wait_for("blocks")["blocked"] == [b.id]
    refused = b.post("/friends/request", {"user_id": a.id})
    assert refused.status == 400 and "block" not in refused.detail.lower()  # they aren't told
    assert a.post("/friends/request", {"user_id": b.id}).status == 400  # unblock first


def test_unblocking_doesnt_make_friends_again(server):
    a, b = server.person(), server.person()
    befriend(a, b)
    a.post("/friends/block", {"user_id": b.id})
    a.post("/friends/unblock", {"user_id": b.id})
    assert friends_of(a)["friends"] == []
    befriend(b, a)  # a new request works again


def test_admins_cant_be_blocked(owner, person):
    assert person.post("/friends/block", {"user_id": owner.id}).status == 400


def test_a_blocked_person_never_counts_as_mentioning_you(server, channel):
    a, b = server.person(), server.person()
    b.post("/friends/block", {"user_id": a.id})
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.drain()
        ws_a.join(channel)
        ws_a.send(type="message", text=f"@{b.name} hello?")
        ws_a.wait_for("message")
        ws_b.nothing("unread", lambda m: "mentions" in m)


# ----- Group DMs

def make_group(starter, others, name=""):
    reply = starter.post("/groups", {"user_ids": [other.id for other in others], "name": name})
    assert reply.status == 200, reply
    return reply.json["key"]


def test_a_group_of_friends(server):
    a, b, c = server.person(), server.person(), server.person()
    befriend(a, b)
    befriend(a, c)
    key = make_group(a, [b, c], name="  Weekend   plans ")
    with c.connect() as ws:
        group = next(g for g in ws.wait_for("groups")["groups"] if g["key"] == key)
        assert group["name"] == "Weekend plans" and set(group["members"]) >= {a.id, b.id, c.id}
        ws.join(key)
        ws.say("hi all")
    # b and c needn't be friends to talk there; every message counts as a mention for the others.
    with b.connect() as ws:
        unread = ws.wait_for("unread")
        assert key in unread["channels"] and unread["mentions"][key] == 1


def test_groups_need_two_friends(server):
    a, b, c = server.person(), server.person(), server.person()
    befriend(a, b)
    assert a.post("/groups", {"user_ids": [b.id]}).status == 400  # one: that's a DM
    assert a.post("/groups", {"user_ids": [b.id, c.id]}).status == 400  # c isn't a friend


def test_at_most_ten_people_in_a_group(server):
    starter = server.person()
    others = [server.person() for _ in range(10)]
    for other in others:
        befriend(starter, other)
    assert starter.post("/groups", {"user_ids": [other.id for other in others]}).status == 400
    key = make_group(starter, others[:9])
    assert starter.post(f"/groups/{key}/add", {"user_ids": [others[9].id]}).status == 400


def test_outsiders_cant_see_or_change_a_group(server):
    a, b, c = server.person(), server.person(), server.person()
    befriend(a, b)
    befriend(a, c)
    key = make_group(a, [b, c])
    stranger = server.person()
    for path in [f"/groups/{key}/rename", f"/groups/{key}/add", f"/groups/{key}/leave"]:
        assert stranger.post(path, {"name": "x", "user_ids": []}).status == 404
    with stranger.connect() as ws:
        ws.send(type="join", channel=key)
        ws.nothing("history")


def test_adding_renaming_and_leaving(server):
    a, b, c, d = server.person(), server.person(), server.person(), server.person()
    befriend(a, b)
    befriend(a, c)
    befriend(b, d)
    key = make_group(a, [b, c])
    with a.connect() as ws:
        ws.join(key)
        ws.say("before d came")
    # b adds their own friend d, who sees the whole history.
    assert b.post(f"/groups/{key}/add", {"user_ids": [d.id]}).status == 200
    with d.connect() as ws:
        assert [m["text"] for m in ws.join(key)["messages"]] == ["before d came"]
    assert c.post(f"/groups/{key}/rename", {"name": "renamed"}).status == 200
    with a.connect() as ws:
        assert next(g for g in ws.wait_for("groups")["groups"] if g["key"] == key)["name"] == "renamed"
    assert c.post(f"/groups/{key}/leave").status == 200
    with c.connect() as ws:
        assert key not in [g["key"] for g in ws.wait_for("groups")["groups"]]
        ws.send(type="join", channel=key)
        ws.nothing("history")


def test_the_last_one_out_deletes_the_group(server):
    a, b, c = server.person(), server.person(), server.person()
    befriend(a, b)
    befriend(a, c)
    key = make_group(a, [b, c])
    word = unique("lastword")
    with a.connect() as ws:
        ws.join(key)
        ws.say(word)
    for person in (a, b, c):
        person.post(f"/groups/{key}/leave")
    # Nobody is in it any more: rejoining by key finds nothing. (That its messages are deleted too can't
    # be seen from outside: nobody may read them either way.)
    with a.connect() as ws:
        ws.send(type="join", channel=key)
        ws.nothing("history")


# ----- Muting

def test_a_muted_chat_doesnt_count_mentions(server, channel):
    a, b = server.person(), server.person()
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.drain()  # (the state every connection starts with: its "mutes" too)
        ws_b.send(type="mute", channel=channel, muted=True)
        assert ws_b.wait_for("mutes")["channels"] == [channel]
        ws_b.drain()
        ws_a.join(channel)
        ws_a.send(type="message", text="@everyone listen")
        ws_a.wait_for("message")
        ws_b.nothing("unread", lambda m: "mentions" in m)
        # Named by name still gets through.
        ws_a.send(type="message", text=f"@{b.name} you too")
        assert ws_b.wait_for("unread", lambda m: "mentions" in m)["mentions"] == {channel: 1}
        ws_b.send(type="mute", channel=channel, muted=False)
        assert ws_b.wait_for("mutes")["channels"] == []


def test_admins_cant_be_muted(owner, person):
    befriend(person, owner)
    with person.connect() as ws:
        ws.drain()
        ws.send(type="mute", channel=dm_key(person, owner), muted=True)
        ws.nothing("mutes")
    owner.post("/friends/remove", {"user_id": person.id})


def test_messages_from_admins_reach_muted_chats(server, owner, channel):
    b = server.person()
    with b.connect() as ws_b, owner.connect() as ws_owner:
        ws_b.drain()
        ws_b.send(type="mute", channel=channel, muted=True)
        ws_b.wait_for("mutes")
        ws_b.drain()
        ws_owner.join(channel)
        ws_owner.send(type="message", text="@everyone important")
        assert ws_b.wait_for("unread", lambda m: "mentions" in m)


# ----- Pinned and recent DMs

def test_pinning_a_dm(friends, server):
    a, b, dm = friends
    with a.connect() as ws:
        ws.drain()
        ws.send(type="pin_chat", channel=dm, pinned=True)
        assert ws.wait_for("pinned_chats")["channels"] == [dm]
        ws.send(type="pin_chat", channel="general", pinned=True)  # only DMs and groups
        ws.nothing("pinned_chats")
        ws.send(type="pin_chat", channel=dm, pinned=False)
        assert ws.wait_for("pinned_chats")["channels"] == []
    stranger = server.person()
    with stranger.connect() as ws:
        ws.drain()
        ws.send(type="pin_chat", channel=dm, pinned=True)  # not theirs
        ws.nothing("pinned_chats")


def test_chat_activity_orders_the_dm_list(friends):
    a, b, dm = friends
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.drain()
        ws_a.join(dm)
        message = ws_a.say("newest")
        assert ws_b.wait_for("chat_activity")["chats"] == {dm: message["id"]}
    with b.connect() as ws:
        assert ws.wait_for("chat_activity")["chats"][dm] == message["id"]


# ----- Statuses

def test_choosing_a_status(server):
    a, watcher = server.person(), server.person()
    with watcher.connect() as ws_w, a.connect() as ws_a:
        assert ws_a.wait_for("welcome")["presence"] == "online"
        ws_w.drain()
        ws_a.send(type="presence", presence="dnd")
        assert ws_a.wait_for("my_presence")["presence"] == "dnd"
        assert ws_w.wait_for("users", lambda m: any(u["id"] == a.id and u["presence"] == "dnd" for u in m["users"]))
        ws_a.send(type="presence", presence="invisible")
        ws_a.wait_for("my_presence")
        seen = ws_w.wait_for("users", lambda m: any(u["id"] == a.id and u["presence"] == "offline" for u in m["users"]))
        assert next(u for u in seen["users"] if u["id"] == a.id)["online"] is False
        ws_a.send(type="presence", presence="sleeping")  # not a status
        ws_a.nothing("my_presence")


def test_online_and_offline(server):
    a, watcher = server.person(), server.person()
    with watcher.connect() as ws_w:
        with a.connect():
            assert ws_w.wait_for("users", lambda m: any(u["id"] == a.id and u["online"] for u in m["users"]))
        assert ws_w.wait_for("users", lambda m: any(u["id"] == a.id and not u["online"] for u in m["users"]))


def test_a_phone_shows_as_a_phone(server):
    a, watcher = server.person(), server.person()
    with watcher.connect() as ws_w, a.connect() as ws_a:
        ws_a.send(type="looking", looking=True, mobile=True)
        assert ws_w.wait_for("users", lambda m: any(u["id"] == a.id and u["mobile"] for u in m["users"]))


def test_activities(server):
    a, watcher = server.person(), server.person()
    with watcher.connect() as ws_w, a.connect() as ws_a:
        ws_a.send(type="activity", activity={"kind": "playing", "name": "  Hollow Knight  "})
        seen = ws_w.wait_for("users", lambda m: any(u["id"] == a.id and u["activity"] for u in m["users"]))
        activity = next(u for u in seen["users"] if u["id"] == a.id)["activity"]
        assert activity["kind"] == "playing" and activity["name"] == "Hollow Knight" and activity["since"]
        ws_a.send(type="activity", activity={"kind": "hacking", "name": "the server"})  # not a kind: nothing
        assert ws_w.wait_for("users", lambda m: any(u["id"] == a.id and u["activity"] is None for u in m["users"]))


# ----- Profile and appearance

def test_status_and_bio(server, person):
    assert person.post("/settings/profile", {"status": "  coding  ", "bio": "I like cats"}).status == 200
    with person.connect() as ws:
        me = user_entry(ws, person)
    assert me["status"] == "coding" and me["bio"] == "I like cats"
    assert person.post("/settings/profile", {"status": "x" * 61, "bio": ""}).status == 400
    assert person.post("/settings/profile", {"status": "", "bio": "x" * 301}).status == 400
    person.post("/settings/profile", {"status": "", "bio": ""})
    with person.connect() as ws:
        assert user_entry(ws, person)["status"] is None


def test_appearance_follows_the_account(person):
    with person.connect() as ws:
        assert ws.wait_for("welcome")["appearance"] is None  # never changed: the defaults
        ws.drain()
        reply = person.post("/settings/appearance", {"theme": "light", "colours": {"accent": "#E91E63"}, "font": "georgia"})
        assert reply.status == 200
        assert ws.wait_for("appearance")["appearance"]["theme"] == "light"  # all their pages hear it
    with person.connect() as ws:
        appearance = ws.wait_for("welcome")["appearance"]
    assert appearance["theme"] == "light" and appearance["font"] == "georgia" and appearance["colours"] == {"accent": "#E91E63"}


def test_appearance_is_checked(person):
    for bad in [{"theme": "neon"}, {"font": "papyrus"}, {"colours": {"accent": "red"}},
                {"colours": {"background-image": "#000000"}}]:
        body = {"theme": "dark", "colours": {}, "font": "system", **bad}
        assert person.post("/settings/appearance", body).status == 400, bad


def test_text_size_and_scale_stay_on_the_device(person):
    """Text size and scale are each device's own (since 2026-10-18): the server ignores them."""
    person.post("/settings/appearance", {"theme": "dark", "colours": {}, "font": "system", "font_size": 99, "scale": 3})
    with person.connect() as ws:
        appearance = ws.wait_for("welcome")["appearance"]
    assert "font_size" not in appearance and "scale" not in appearance
