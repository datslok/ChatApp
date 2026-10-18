"""Which device a message was sent from ("sent_from"): saved with it and given to bots only, so Chattus can
explain the way to a setting for the device someone asks on. People's pages must never get it."""
import pytest


@pytest.mark.parametrize("looking, device", [
    ({"mobile": True, "android": True}, "android app"),
    ({"app": True}, "windows app"),
    ({"mobile": True}, "phone browser"),
    ({}, "web browser"),
])
def test_bots_see_the_device_and_people_dont(server, bot, channel, looking, device):
    sender, reader = server.person(), server.person()
    with bot.connect() as ws_bot, reader.connect() as ws_reader, sender.connect() as ws:
        ws_bot.join(channel)
        ws_reader.join(channel)
        ws.send(type="looking", looking=True, **looking)
        ws.join(channel)
        mine = ws.say("where are my settings?")
        assert "sent_from" not in mine
        assert ws_bot.wait_for("message")["sent_from"] == device
        assert "sent_from" not in ws_reader.wait_for("message")
    # The history keeps it, for the bot only.
    with bot.connect() as ws_bot:
        assert ws_bot.join(channel)["messages"][-1]["sent_from"] == device
    with reader.connect() as ws:
        assert "sent_from" not in ws.join(channel)["messages"][-1]


def test_no_other_message_list_gives_it_away(server, friends):
    a, b, dm = friends
    with a.connect() as ws:
        ws.send(type="looking", looking=True, mobile=True, android=True)
        ws.join(dm)
        message = ws.say("https://example.com/x findme")
        ws.send(type="pin", message_id=message["id"], pinned=True)
        ws.wait_for("pinned")
    with b.connect() as ws:
        ws.join(dm)
        ws.send(type="older", before=message["id"] + 100)
        ws.send(type="pins")
        ws.send(type="search", query="findme", channel=dm)
        ws.send(type="chat_info", tab="links", before=None)
        for kind, key in [("older", "messages"), ("pins", "messages"), ("search_results", "results"), ("chat_info", "items")]:
            items = ws.wait_for(kind)[key]
            assert items and all("sent_from" not in item for item in items), kind
