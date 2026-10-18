"""Voice: tickets into LiveKit rooms (who may get one), who's in voice, and calls in DMs and groups
(ringing, answering, declining, hanging up, the call notes). LiveKit itself isn't running: the server
only signs tickets for it, and the pages tell the server which room they're in."""
import base64
import hashlib
import hmac
import json

from conftest import Client, befriend

SECRET = "test-secret-that-is-long-enough-for-hs256"  # conftest gives the test server this one


def decode(token):
    """A JWT's payload, after checking its signature with the test secret."""
    header, payload, signature = token.split(".")
    expected = hmac.new(SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    assert base64.urlsafe_b64decode(signature + "==") == expected, "bad signature"
    return json.loads(base64.urlsafe_b64decode(payload + "=="))


# ----- Tickets

def test_a_ticket_into_the_lounge(person):
    reply = person.get("/voice-token?room=lounge")
    assert reply.status == 200 and reply.json["url"] == "ws://127.0.0.1:7999"
    claims = decode(reply.json["token"])
    assert claims["sub"] == str(person.id) and claims["name"] == person.name
    assert claims["video"] == {"room": "lounge", "roomJoin": True, "canPublish": True, "canSubscribe": True}
    assert claims["exp"] - claims["nbf"] == 600


def test_tickets_only_for_your_own_calls(server, friends):
    a, b, dm = friends
    assert a.get(f"/voice-token?room={dm}").status == 200
    assert server.person().get(f"/voice-token?room={dm}").status == 403
    assert a.get("/voice-token?room=general").status == 403  # not a voice room
    assert Client().get("/voice-token?room=lounge").status == 401


# ----- Who's in voice

def test_everyone_sees_whos_in_the_lounge(server):
    a, watcher = server.person(), server.person()
    with watcher.connect() as ws_w, a.connect() as ws_a:
        ws_w.drain()
        ws_a.send(type="voice", room="lounge", muted=True)
        rooms = ws_w.wait_for("voice_members", lambda m: m["rooms"]["lounge"])["rooms"]
        assert {"id": a.id, "muted": True, "deafened": False} in rooms["lounge"]
        ws_a.send(type="voice", room=None)
        assert ws_w.wait_for("voice_members", lambda m: all(x["id"] != a.id for x in m["rooms"]["lounge"]))


def test_closing_the_page_leaves_voice(server):
    a, watcher = server.person(), server.person()
    with watcher.connect() as ws_w:
        with a.connect() as ws_a:
            ws_a.send(type="voice", room="lounge")
            ws_w.wait_for("voice_members", lambda m: any(x["id"] == a.id for x in m["rooms"]["lounge"]))
        assert ws_w.wait_for("voice_members", lambda m: all(x["id"] != a.id for x in m["rooms"]["lounge"]))


def test_nobody_says_theyre_in_someone_elses_call(server, friends):
    a, b, dm = friends
    stranger = server.person()
    with a.connect() as ws_a, stranger.connect() as ws_s:
        ws_a.drain()
        ws_s.send(type="voice", room=dm)
        ws_a.nothing("dm_call")


# ----- DM calls

def test_a_dm_call_rings_is_answered_and_ends(friends):
    a, b, dm = friends
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(dm)
        ws_a.send(type="call", channel=dm)
        ring = ws_b.wait_for("call")
        assert ring == {"type": "call", "channel": dm, "from": a.id, "name": a.name}
        ws_a.send(type="voice", room=dm)
        assert ws_b.wait_for("dm_call", lambda m: m["members"])["members"][0]["id"] == a.id
        ws_b.send(type="call_answer", channel=dm, accept=True)
        assert ws_a.wait_for("call_answered")["channel"] == dm
        ws_b.wait_for("call_answered")  # all b's pages stop ringing
        ws_b.send(type="voice", room=dm)
        # Both leave: the call is over, and a note says so.
        ws_a.send(type="voice", room=None)
        ws_b.send(type="voice", room=None)
        assert ws_b.wait_for("call_ended")["reason"] == "ended"
        note = ws_a.wait_for("message", lambda m: m["kind"] == "call")
        assert note["text"] == "📞 Call · under a minute" and note["user_id"] == a.id


def test_declining_a_dm_call(friends):
    a, b, dm = friends
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(dm)
        ws_a.send(type="call", channel=dm)
        ws_b.wait_for("call")
        ws_b.send(type="call_answer", channel=dm, accept=False)
        assert ws_a.wait_for("call_ended")["reason"] == "declined"
        assert ws_a.wait_for("message", lambda m: m["kind"] == "call")["text"] == "📞 Declined call"


def test_declining_from_the_phones_notification(friends):
    a, b, dm = friends
    with a.connect() as ws_a:
        ws_a.send(type="call", channel=dm)
        assert b.post("/calls/decline", {"channel": dm}).status == 200
        assert ws_a.wait_for("call_ended")["reason"] == "declined"


def test_hanging_up_before_an_answer(friends):
    a, b, dm = friends
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(dm)
        ws_a.send(type="call", channel=dm)
        ws_b.wait_for("call")
        ws_a.send(type="call_cancel", channel=dm)
        assert ws_b.wait_for("call_ended")["reason"] == "cancelled"
        assert ws_a.wait_for("message", lambda m: m["kind"] == "call")["text"] == "📞 Missed call"


def test_only_the_caller_can_cancel_and_strangers_cant_call(server, friends):
    a, b, dm = friends
    stranger = server.person()
    with a.connect() as ws_a, b.connect() as ws_b, stranger.connect() as ws_s:
        ws_s.send(type="call", channel=dm)
        ws_b.nothing("call")
        ws_a.send(type="call", channel=dm)
        ws_b.wait_for("call")
        ws_b.send(type="call_cancel", channel=dm)  # not b's call to cancel
        ws_a.nothing("call_ended")
        ws_a.send(type="call_cancel", channel=dm)
        ws_b.wait_for("call_ended")


def test_a_call_already_ringing_for_you_is_answered_by_calling(friends):
    a, b, dm = friends
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.send(type="call", channel=dm)
        ws_b.wait_for("call")
        ws_b.send(type="call", channel=dm)  # both pressed Call at once
        assert ws_a.wait_for("call_answered")
        ws_a.send(type="call_cancel", channel=dm)  # (started: cancel does nothing now)
        ws_b.nothing("call_ended")


# ----- Group calls

def test_a_group_call_rings_everyone_and_a_decline_is_only_yours(server):
    a, b, c = server.person(), server.person(), server.person()
    befriend(a, b)
    befriend(a, c)
    key = a.post("/groups", {"user_ids": [b.id, c.id]}).json["key"]
    with a.connect() as ws_a, b.connect() as ws_b, c.connect() as ws_c:
        ws_a.send(type="call", channel=key)
        ws_b.wait_for("call")
        ws_c.wait_for("call")
        ws_b.send(type="call_answer", channel=key, accept=False)
        assert ws_b.wait_for("call_answered")  # b's ringing stops...
        ws_a.nothing("call_ended")  # ...but the call goes on for c
        ws_c.send(type="call_answer", channel=key, accept=True)
        assert ws_a.wait_for("call_answered")


def test_whoever_blocked_the_caller_isnt_rung(server):
    a, b, c = server.person(), server.person(), server.person()
    befriend(a, b)
    befriend(a, c)
    key = a.post("/groups", {"user_ids": [b.id, c.id]}).json["key"]
    befriend(b, c)
    c.post("/friends/block", {"user_id": b.id})
    with b.connect() as ws_b, c.connect() as ws_c, a.connect() as ws_a:
        ws_b.send(type="call", channel=key)
        ws_a.wait_for("call")
        ws_c.nothing("call")
