"""Messages: sending, who may write where, history and scrolling up, editing and deleting, replies,
reactions, mentions and unread counts, pins, typing, search, and a DM's chat info tabs."""
from conftest import befriend, dm_key, unique


def from_user(person):
    return lambda message: message.get("user_id") == person.id


# ----- Sending

def test_a_message_reaches_everyone_in_the_channel(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(channel)
        ws_b.join(channel)
        sent = ws_a.say("hello there")
        heard = ws_b.wait_for("message", from_user(a))
    assert heard["id"] == sent["id"] and heard["text"] == "hello there" and heard["name"] == a.name
    assert sent["channel"] == channel and sent["reactions"] == [] and sent["kind"] is None


def test_the_sender_comes_from_the_login_not_the_message(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="I am the owner", user_id=1, name="owner")
        message = ws.wait_for("message")
    assert message["user_id"] == a.id and message["name"] == a.name


def test_too_long_and_empty_messages_are_refused(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="x" * 2001)
        ws.send(type="message", text="   ")
        ws.nothing("message")
        ws.send(type="message", text="x" * 2001, nonce="n1")
        assert ws.wait_for("not_sent")["nonce"] == "n1"
        assert ws.say("x" * 2000)["text"] == "x" * 2000


def test_text_is_trimmed_and_never_html(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="  <b>bold?</b>  ")
        assert ws.wait_for("message")["text"] == "<b>bold?</b>"  # stored as typed: the pages show it as text


def test_a_repeated_nonce_is_saved_once(server, channel):
    """The phone app's outbox sends a message again after a reconnect: the server confirms it again
    without saving it twice."""
    a = server.person()
    nonce = unique("nonce")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="once", nonce=nonce)
        first = ws.wait_for("message")
        assert ws.wait_for("sent")["id"] == first["id"]
        ws.send(type="message", text="once", nonce=nonce)
        assert ws.wait_for("sent")["id"] == first["id"]
        ws.nothing("message")
    with a.connect() as ws:
        assert [m["text"] for m in ws.join(channel)["messages"]] == ["once"]


def test_a_message_may_name_its_chat(server, channel):
    """The outbox again: sent from whatever chat is open by then, it names its own."""
    a = server.person()
    with a.connect() as ws:
        ws.send(type="message", text="from afar", channel=channel, nonce=unique("n"))
        assert ws.wait_for("sent")["channel"] == channel
    with a.connect() as ws:
        assert [m["text"] for m in ws.join(channel)["messages"]] == ["from afar"]


def test_nobody_writes_in_a_dm_that_isnt_theirs(server, friends):
    a, b, dm = friends
    stranger = server.person("stranger")
    with stranger.connect() as ws:
        ws.send(type="join", channel=dm)
        ws.nothing("history")
        ws.send(type="message", text="sneaky", channel=dm, nonce="x")
        assert ws.wait_for("not_sent")["nonce"] == "x"
    with a.connect() as ws:
        assert ws.join(dm)["messages"] == []


def test_a_dm_needs_friends(server):
    a, b = server.person(), server.person()
    with a.connect() as ws:
        ws.send(type="join", channel=dm_key(a, b))
        ws.nothing("history")
    befriend(a, b)
    with a.connect() as ws:
        ws.join(dm_key(a, b))
        assert ws.say("now we can talk")["channel"] == dm_key(a, b)
    # Unfriended: the DM closes again, but its messages stay (back when friends again).
    a.post("/friends/remove", {"user_id": b.id})
    with a.connect() as ws:
        ws.send(type="join", channel=dm_key(a, b))
        ws.nothing("history")
    befriend(a, b)
    with a.connect() as ws:
        assert [m["text"] for m in ws.join(dm_key(a, b))["messages"]] == ["now we can talk"]


# ----- History

def test_history_and_scrolling_up(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        sent = [ws.say(f"message {n}") for n in range(55)]
    with a.connect() as ws:
        history = ws.join(channel)
        assert history["more"] is True
        assert [m["text"] for m in history["messages"]] == [f"message {n}" for n in range(5, 55)]  # the newest 50, oldest first
        ws.send(type="older", before=history["messages"][0]["id"])
        older = ws.wait_for("older")
    assert [m["text"] for m in older["messages"]] == [f"message {n}" for n in range(5)]
    assert older["more"] is False
    assert sent[0]["id"] < sent[-1]["id"]


def test_older_ignores_nonsense(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        for before in [True, "12", -1, 2**64]:
            ws.send(type="older", before=before)
        ws.nothing("older")


def test_last_read_marks_where_you_stopped(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws:
        first = ws.join(channel)
        assert first["last_read"] is None  # never opened
        seen = ws.say("seen")
    with b.connect() as ws:
        ws.join(channel)
        ws.say("new one")
    with a.connect() as ws:
        assert ws.join(channel)["last_read"] == seen["id"]


# ----- Editing and deleting

def test_editing_your_own_message(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(channel)
        ws_b.join(channel)
        message = ws_a.say("typo")
        ws_a.send(type="edit", message_id=message["id"], text="fixed")
        edited = ws_b.wait_for("edited")
        assert edited["message_id"] == message["id"] and edited["text"] == "fixed" and edited["edited_at"]
        ws_a.wait_for("edited")  # (the sender hears it too)
        # Someone else's: refused (silently).
        ws_b.send(type="edit", message_id=message["id"], text="hacked")
        ws_b.send(type="delete", message_id=message["id"])
        ws_a.nothing("edited")
        ws_a.nothing("deleted")
    with a.connect() as ws:
        assert ws.join(channel)["messages"][0]["text"] == "fixed"


def test_an_edit_cant_empty_a_message_without_a_file(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        message = ws.say("keep me")
        ws.send(type="edit", message_id=message["id"], text="")
        ws.nothing("edited")


def test_deleting_and_replies_to_deleted_messages(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(channel)
        ws_b.join(channel)
        original = ws_a.say("original")
        reply = ws_b.say("a reply", reply_to=original["id"])
        assert reply["reply"]["id"] == original["id"] and reply["reply"]["name"] == a.name
        ws_a.send(type="delete", message_id=original["id"])
        assert ws_b.wait_for("deleted")["message_id"] == original["id"]
    with a.connect() as ws:
        messages = ws.join(channel)["messages"]
    assert [m["text"] for m in messages] == ["a reply"]
    assert messages[0]["reply"] == {"id": original["id"], "deleted": True}


def test_admins_edit_and_delete_anyones_messages(server, owner, channel):
    a = server.person()
    with a.connect() as ws_a, owner.connect() as ws_owner:
        ws_a.join(channel)
        ws_owner.join(channel)
        message = ws_a.say("rude words")
        ws_owner.send(type="edit", message_id=message["id"], text="[removed]")
        assert ws_a.wait_for("edited")["text"] == "[removed]"
        ws_owner.send(type="delete", message_id=message["id"])
        assert ws_a.wait_for("deleted")["message_id"] == message["id"]


def test_a_reply_to_another_chat_is_sent_as_a_plain_message(server, channel, friends):
    a, b, dm = friends
    with a.connect() as ws:
        ws.join(dm)
        secret = ws.say("secret")
    stranger = server.person()
    with stranger.connect() as ws:
        ws.join(channel)
        message = ws.say("quoting", reply_to=secret["id"])
    assert message["reply"] is None


# ----- Reactions

def test_reactions_toggle(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(channel)
        ws_b.join(channel)
        message = ws_a.say("react to me")
        ws_b.send(type="react", message_id=message["id"], emoji="👍")
        assert ws_a.wait_for("reactions")["reactions"] == [{"emoji": "👍", "user_ids": [b.id]}]
        ws_a.send(type="react", message_id=message["id"], emoji="👍")
        assert ws_b.wait_for("reactions", lambda m: len(m["reactions"][0]["user_ids"]) == 2)
        ws_b.send(type="react", message_id=message["id"], emoji="👍")  # again: taken back
        assert ws_a.wait_for("reactions", lambda m: m["reactions"] == [{"emoji": "👍", "user_ids": [a.id]}])


def test_only_real_emoji_are_reactions(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        message = ws.say("hm")
        for emoji in ["lol", "<b>", "custom:999999", "👍👍"]:
            ws.send(type="react", message_id=message["id"], emoji=emoji)
        ws.nothing("reactions")


def test_no_reacting_in_someone_elses_dm(server, friends):
    a, b, dm = friends
    with a.connect() as ws:
        ws.join(dm)
        message = ws.say("private")
    stranger = server.person()
    with stranger.connect() as ws_s, a.connect() as ws_a:
        ws_a.join(dm)
        ws_s.send(type="react", message_id=message["id"], emoji="👍")
        ws_a.nothing("reactions")


# ----- Mentions and unread

def test_unread_dots_and_mentions(server, channel):
    a, b = server.person(), server.person()
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.drain()
        ws_a.join(channel)
        ws_a.say("no mention here")
        unread = ws_b.wait_for("unread", lambda m: m["channels"] == [channel])
        assert "mentions" not in unread
        ws_a.send(type="message", text=f"hey @{b.name}")
        mentioned = ws_a.wait_for("message")
        assert mentioned["text"] == f"hey <@{b.id}>"  # stored by id, so a new name still shows
        unread = ws_b.wait_for("unread", lambda m: "mentions" in m)
        assert unread["mentions"] == {channel: 1}
        assert unread["notify"]["user_id"] == a.id and unread["notify"]["id"] == mentioned["id"]
    # Still unread after reconnecting; opening the chat reads it.
    with b.connect() as ws:
        unread = ws.wait_for("unread")
        assert channel in unread["channels"] and unread["mentions"][channel] == 1
        ws.join(channel)
    with b.connect() as ws:
        unread = ws.wait_for("unread")
        assert channel not in unread["channels"] and channel not in unread["mentions"]


def test_everyone_mentions_everybody(server, channel):
    a, b = server.person(), server.person()
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.drain()
        ws_a.join(channel)
        ws_a.send(type="message", text="@everyone meeting")
        assert ws_a.wait_for("message")["text"] == "<@everyone> meeting"
        assert ws_b.wait_for("unread", lambda m: "mentions" in m)["mentions"] == {channel: 1}


def test_an_email_address_isnt_a_mention(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text=f"mail me at x@{b.name}")
        assert ws.wait_for("message")["text"] == f"mail me at x@{b.name}"


def test_every_dm_message_counts_as_a_mention(friends):
    a, b, dm = friends
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.drain()
        ws_a.join(dm)
        ws_a.say("psst")
        unread = ws_b.wait_for("unread", lambda m: "mentions" in m)
        assert unread["mentions"] == {dm: 1} and unread["notify"]["text"] == "psst"


def test_whoever_looks_at_the_chat_has_read_it(server, channel):
    a, b = server.person(), server.person()
    with b.connect() as ws_b, a.connect() as ws_a:
        ws_b.join(channel)
        ws_b.drain()  # (the "unread" every connection starts with)
        ws_a.join(channel)
        ws_a.say("you're watching")
        ws_b.nothing("unread")
    with b.connect() as ws:
        assert channel not in ws.wait_for("unread")["channels"]


# ----- Pins

def test_pinning(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(channel)
        ws_b.join(channel)
        message = ws_a.say("remember this")
        ws_b.send(type="pin", message_id=message["id"], pinned=True)  # anyone who sees it may pin
        assert ws_a.wait_for("pinned") == {"type": "pinned", "channel": channel, "message_id": message["id"], "pinned": True}
        note = ws_a.wait_for("message", lambda m: m["kind"] == "pin")
        assert note["reply"]["id"] == message["id"] and note["user_id"] == b.id
        ws_a.send(type="pins")
        assert [m["id"] for m in ws_a.wait_for("pins")["messages"]] == [message["id"]]
        # The note itself can't be pinned or edited.
        ws_a.send(type="pin", message_id=note["id"], pinned=True)
        ws_b.send(type="edit", message_id=note["id"], text="changed")
        ws_a.nothing("pinned")
        ws_a.nothing("edited")
        ws_b.send(type="pin", message_id=message["id"], pinned=False)
        assert ws_a.wait_for("pinned")["pinned"] is False
    with a.connect() as ws:
        history = ws.join(channel)["messages"]
        assert next(m for m in history if m["id"] == message["id"])["pinned"] is False


def test_at_most_100_pins_per_chat(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        for n in range(101):
            message = ws.say(f"pin {n}")
            ws.send(type="pin", message_id=message["id"], pinned=True)
            if n < 100:
                ws.wait_for("pinned", lambda m: m["message_id"] == message["id"])
        assert ws.wait_for("pins_full")["max"] == 100


# ----- Typing

def test_typing_reaches_the_others_only(server, channel):
    a, b = server.person(), server.person()
    with a.connect() as ws_a, b.connect() as ws_b:
        ws_a.join(channel)
        ws_b.join(channel)
        ws_a.send(type="typing")
        assert ws_b.wait_for("typing")["name"] == a.name
        ws_a.nothing("typing")


# ----- Search

def test_search_finds_words_and_their_starts(server, channel):
    a = server.person()
    word = unique("zebra")
    with a.connect() as ws:
        ws.join(channel)
        found = ws.say(f"the {word} crossed the road")
        ws.say("nothing to see")
        ws.send(type="search", query=word[:-1], channel=channel, ask=7)  # the start of the word is enough
        results = ws.wait_for("search_results")
    assert results["ask"] == 7
    assert [m["id"] for m in results["results"]] == [found["id"]] and results["results"][0]["channel"] == channel


def test_search_only_looks_where_you_may(server, friends):
    a, b, dm = friends
    word = unique("secretword")
    with a.connect() as ws:
        ws.join(dm)
        ws.say(f"our {word}")
    stranger = server.person()
    with stranger.connect() as ws:
        ws.send(type="search", query=word, channel=None)
        assert ws.wait_for("search_results")["results"] == []
        ws.send(type="search", query=word, channel=dm)  # asking for their DM by name doesn't help
        assert ws.wait_for("search_results")["results"] == []
    with b.connect() as ws:
        ws.send(type="search", query=word, channel=None)
        assert len(ws.wait_for("search_results")["results"]) == 1


def test_search_by_person_and_fts_syntax_is_plain_text(server, channel):
    a, b = server.person(), server.person()
    word = unique("pizza")
    with a.connect() as ws:
        ws.join(channel)
        ws.say(f"{word} from a")
    with b.connect() as ws:
        ws.join(channel)
        ws.say(f"{word} from b")
        ws.send(type="search", query=word, channel=channel, **{"from": b.id})
        assert [m["user_id"] for m in ws.wait_for("search_results")["results"]] == [b.id]
        ws.send(type="search", query=f'{word}" OR "x', channel=channel)  # no FTS5 syntax gets through
        assert len(ws.wait_for("search_results")["results"]) == 0


def test_search_leaves_out_blocked_people(server, channel):
    a, b = server.person(), server.person()
    word = unique("blockword")
    with a.connect() as ws:
        ws.join(channel)
        ws.say(word)
    b.post("/friends/block", {"user_id": a.id})
    with b.connect() as ws:
        ws.send(type="search", query=word, channel=channel)
        assert ws.wait_for("search_results")["results"] == []


# ----- A DM's chat info tabs

def test_chat_info_tabs(server, friends):
    a, b, dm = friends
    upload = a.post("/upload?filename=notes.txt", raw=b"some notes", content_type="text/plain").json
    with a.connect() as ws:
        ws.join(dm)
        ws.say("look at https://example.com/a. and `https://in.code`")
        ws.send(type="message", text="", file=upload["id"])
        file_message = ws.wait_for("message", lambda m: m["file"] is not None)
        for tab, expected in [("links", 1), ("files", 1), ("media", 0)]:
            ws.send(type="chat_info", tab=tab, before=None)
            answer = ws.wait_for("chat_info", lambda m: m["tab"] == tab)
            assert len(answer["items"]) == expected, tab
        ws.send(type="chat_info", tab="links", before=None)
        links = ws.wait_for("chat_info", lambda m: m["tab"] == "links")["items"][0]["links"]
        assert links == ["https://example.com/a"]
        ws.send(type="chat_info", tab="files", before=None)
        assert ws.wait_for("chat_info", lambda m: m["tab"] == "files")["items"][0]["id"] == file_message["id"]


def test_chat_info_is_only_for_dms_and_groups(server, channel):
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="chat_info", tab="links", before=None)
        ws.nothing("chat_info")


def test_ping(person):
    with person.connect() as ws:
        ws.send(type="ping")
        ws.wait_for("pong")
