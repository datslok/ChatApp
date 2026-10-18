"""Files: uploads and who may download them, pictures and videos vs other files, profile pictures and
banners, and custom emoji."""
import io

from PIL import Image

from conftest import Client, unique


def picture(kind="PNG", size=(32, 32), frames=1):
    """A real little picture's bytes, made with Pillow (a GIF with `frames` frames)."""
    images = [Image.new("RGB", size, (n * 40 % 256, 120, 200)) for n in range(frames)]
    out = io.BytesIO()
    images[0].save(out, format=kind, save_all=frames > 1, append_images=images[1:], duration=100)
    return out.getvalue()


def upload(person, name, data, content_type):
    reply = person.post(f"/upload?filename={name}", raw=data, content_type=content_type)
    assert reply.status == 200, reply
    return reply.json["id"]


# ----- Uploads

def test_a_file_in_a_message(server, channel):
    a, b = server.person(), server.person()
    file_id = upload(a, "notes.txt", b"hello file", "text/plain")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="my notes", file=file_id)
        message = ws.wait_for("message")
    assert message["file"] == {"id": file_id, "filename": "notes.txt", "size": 10, "image": False, "video": False}
    download = b.get(f"/uploads/{file_id}")
    assert download.status == 200 and download.body == b"hello file"
    # Not a picture: always downloaded, never opened as a page on our site.
    assert download.headers["Content-Type"] == "application/octet-stream"
    assert download.headers["Content-Disposition"].startswith("attachment")
    assert download.headers["X-Content-Type-Options"] == "nosniff"


def test_pictures_are_shown_and_other_types_arent_believed(server, channel):
    a = server.person()
    picture_id = upload(a, "cat.png", picture(), "image/png")
    page_id = upload(a, "evil.html", b"<script>alert(1)</script>", "text/html")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", file=picture_id)
        assert ws.wait_for("message")["file"]["image"] is True
        ws.send(type="message", text="", file=page_id)
        assert ws.wait_for("message")["file"]["image"] is False
    shown = a.get(f"/uploads/{picture_id}")
    assert shown.headers["Content-Type"] == "image/png" and shown.headers["Content-Disposition"].startswith("inline")
    assert a.get(f"/uploads/{page_id}").headers["Content-Type"] == "application/octet-stream"


def test_a_video_must_really_be_one(server, channel):
    a = server.person()
    real = upload(a, "clip.mp4", b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200, "video/mp4")
    fake = upload(a, "fake.mp4", b"not a video at all", "video/mp4")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", file=real)
        assert ws.wait_for("message")["file"]["video"] is True
        ws.send(type="message", text="", file=fake)
        assert ws.wait_for("message")["file"]["video"] is False


def test_an_unsent_file_is_only_for_its_uploader(server):
    a, b = server.person(), server.person()
    file_id = upload(a, "draft.txt", b"draft", "text/plain")
    assert a.get(f"/uploads/{file_id}").status == 200
    assert b.get(f"/uploads/{file_id}").status == 404
    assert Client().get(f"/uploads/{file_id}").status == 404


def test_a_dm_file_is_only_for_the_dm(server, friends):
    a, b, dm = friends
    file_id = upload(a, "secret.txt", b"secret", "text/plain")
    with a.connect() as ws:
        ws.join(dm)
        ws.send(type="message", text="", file=file_id)
        ws.wait_for("message")
    assert b.get(f"/uploads/{file_id}").status == 200
    assert server.person().get(f"/uploads/{file_id}").status == 404


def test_a_file_can_only_be_sent_once_and_only_by_its_uploader(server, channel):
    a, b = server.person(), server.person()
    file_id = upload(a, "once.txt", b"once", "text/plain")
    with b.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="mine now", file=file_id, nonce="n1")
        assert ws.wait_for("not_sent")["nonce"] == "n1"
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", file=file_id)
        ws.wait_for("message")
        ws.send(type="message", text="again", file=file_id, nonce="n2")
        assert ws.wait_for("not_sent")["nonce"] == "n2"


def test_deleting_the_message_deletes_the_file(server, channel):
    a = server.person()
    file_id = upload(a, "gone.txt", b"bye", "text/plain")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", file=file_id)
        message = ws.wait_for("message")
        ws.send(type="delete", message_id=message["id"])
        ws.wait_for("deleted")
    assert a.get(f"/uploads/{file_id}").status == 404


# ----- Several files in one message

def test_several_files_in_one_message(server, channel):
    a, b = server.person(), server.person()
    ids = [upload(a, f"cat{n}.png", picture(), "image/png") for n in range(3)]
    ids.append(upload(a, "notes.txt", b"notes", "text/plain"))
    with a.connect() as ws:
        ws.join(channel)
        message = ws.say("my cats", files=ids)
        # In the order they were sent, and "file" (for older apps) is the first of them.
        assert [file["id"] for file in message["files"]] == ids
        assert [file["image"] for file in message["files"]] == [True, True, True, False]
        assert message["file"] == message["files"][0]
    with b.connect() as ws:
        history = ws.join(channel)["messages"]
    assert [file["id"] for file in history[-1]["files"]] == ids  # the history has them all too, in order
    assert all(b.get(f"/uploads/{file_id}").status == 200 for file_id in ids)


def test_several_files_are_sent_all_or_none(server, channel):
    a, b = server.person(), server.person()
    mine = upload(a, "mine.txt", b"mine", "text/plain")
    theirs = upload(b, "theirs.txt", b"theirs", "text/plain")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="both", files=[mine, theirs], nonce="n1")
        assert ws.wait_for("not_sent")["nonce"] == "n1"
        # Nothing was used up: our own file can still be sent.
        assert [file["id"] for file in ws.say("just mine", files=[mine])["files"]] == [mine]


def test_at_most_ten_different_files_in_a_message(server, channel):
    a = server.person()
    ids = [upload(a, f"f{n}.txt", b"x", "text/plain") for n in range(11)]
    with a.connect() as ws:
        ws.join(channel)
        for n, files in enumerate([ids, [ids[0], ids[0]], [], "not a list", [17]]):
            ws.send(type="message", text="files", files=files, nonce=f"bad{n}")
            assert ws.wait_for("not_sent")["nonce"] == f"bad{n}"
        assert len(ws.say("ten", files=ids[:10])["files"]) == 10


def test_deleting_a_message_deletes_all_its_files(server, channel):
    a = server.person()
    ids = [upload(a, f"gone{n}.txt", b"bye", "text/plain") for n in range(3)]
    with a.connect() as ws:
        ws.join(channel)
        message = ws.say("", files=ids)
        ws.send(type="delete", message_id=message["id"])
        ws.wait_for("deleted")
    assert all(a.get(f"/uploads/{file_id}").status == 404 for file_id in ids)


def test_an_emptied_caption_keeps_the_files(server, channel):
    a = server.person()
    ids = [upload(a, f"keep{n}.txt", b"keep", "text/plain") for n in range(2)]
    with a.connect() as ws:
        ws.join(channel)
        message = ws.say("a caption", files=ids)
        ws.send(type="edit", message_id=message["id"], text="")
        assert ws.wait_for("edited")["text"] == ""


def test_chat_info_shows_a_message_in_each_tab_it_has_files_for(friends):
    a, b, dm = friends
    ids = [upload(a, "cat.png", picture(), "image/png"), upload(a, "notes.txt", b"notes", "text/plain")]
    with a.connect() as ws:
        ws.join(dm)
        message = ws.say("both kinds", files=ids)
        for tab in ("media", "files"):
            ws.send(type="chat_info", tab=tab, before=None)
            info = ws.wait_for("chat_info", lambda answer: answer["tab"] == tab)
            assert [item["id"] for item in info["items"]] == [message["id"]]


def test_uploads_need_a_login_and_something_in_them(person):
    assert Client().post("/upload?filename=x.txt", raw=b"x", content_type="text/plain").status == 401
    assert person.post("/upload?filename=empty.txt", raw=b"", content_type="text/plain").status == 400


def test_a_file_name_cant_reach_outside_the_folder(server, channel):
    """The name people see is kept, but the file on disk gets a random name."""
    a = server.person()
    file_id = upload(a, "../../server.py", b"not the server", "text/plain")
    assert "/" not in file_id and ".." not in file_id
    assert a.get(f"/uploads/{file_id}").body == b"not the server"
    assert Client().get("/login").status == 200  # (server.py itself is untouched: the server still runs)


# ----- Profile pictures and banners

def test_a_profile_picture(server):
    a, b = server.person(), server.person()
    reply = a.post("/settings/avatar", raw=picture(), content_type="image/png")
    assert reply.status == 200
    avatar = reply.json["avatar"]
    with b.connect() as ws:
        assert next(u for u in ws.wait_for("users")["users"] if u["id"] == a.id)["avatar"] == avatar
    assert b.get(f"/avatars/{avatar}").status == 200
    assert Client().get(f"/avatars/{avatar}").status == 404  # logged in only
    # A new one gets a new name (browsers keep old pictures), and the old one is gone.
    newer = a.post("/settings/avatar", raw=picture("JPEG"), content_type="image/jpeg").json["avatar"]
    assert newer != avatar and newer.endswith(".jpg")
    assert b.get(f"/avatars/{avatar}").status == 404
    assert a.delete("/settings/avatar").status == 200
    assert b.get(f"/avatars/{newer}").status == 404


def test_an_animated_gif_is_cropped_on_the_server(person):
    gif = picture("GIF", size=(64, 48), frames=3)
    reply = person.post("/settings/avatar?left=8&top=0&width=48&height=48", raw=gif, content_type="image/gif")
    assert reply.status == 200 and reply.json["avatar"].endswith(".webp")
    stored = Image.open(io.BytesIO(person.get(f"/avatars/{reply.json['avatar']}").body))
    assert stored.size == (256, 256) and getattr(stored, "n_frames", 1) == 3


def test_a_crop_outside_the_picture_is_refused(person):
    reply = person.post("/settings/banner?left=500&top=0&width=10&height=10",
                        raw=picture("GIF", frames=2), content_type="image/gif")
    assert reply.status == 400


def test_banners_and_picture_types(person):
    reply = person.post("/settings/banner", raw=picture(size=(96, 32)), content_type="image/png")
    assert reply.status == 200 and person.get(f"/banners/{reply.json['banner']}").status == 200
    assert person.post("/settings/banner", raw=b"<svg/>", content_type="image/svg+xml").status == 400
    assert person.delete("/settings/banner").status == 200


def test_a_picture_too_big_is_refused(person):
    too_big = b"\x89PNG" + b"\x00" * (1024 * 1024 + 1)  # just over the 1 MB for profile pictures
    assert person.post("/settings/avatar", raw=too_big, content_type="image/png").status == 413


# ----- Custom emoji

def test_custom_emoji(server, channel):
    a, b = server.person(), server.person()
    name = unique("blob_")
    with b.connect() as ws_b:
        ws_b.drain()
        assert a.post(f"/custom-emoji?name={name}", raw=picture(), content_type="image/png").status == 200
        emoji = next(e for e in ws_b.wait_for("custom_emoji")["emoji"] if e["name"] == name)  # everyone's picker
    assert emoji["owner_id"] == a.id
    assert b.get(f"/custom-emoji/files/{emoji['file']}").status == 200
    with a.connect() as ws:
        ws.join(channel)
        # :name: in a message becomes its id, so a renamed or deleted one never turns into another.
        ws.send(type="message", text=f"look :{name}: and :nope:")
        message = ws.wait_for("message")
        assert message["text"] == f"look <:{emoji['id']}> and :nope:"
        ws.send(type="react", message_id=message["id"], emoji=f"custom:{emoji['id']}")
        assert ws.wait_for("reactions")["reactions"][0]["emoji"] == f"custom:{emoji['id']}"
        # Deleting it takes its reactions away too.
        assert b.delete(f"/custom-emoji/{emoji['id']}").status == 404  # not b's
        assert a.delete(f"/custom-emoji/{emoji['id']}").status == 200
        assert ws.wait_for("reactions")["reactions"] == []


def test_custom_emoji_names_are_checked(server, person):
    name = unique("dup_")
    assert person.post(f"/custom-emoji?name={name}", raw=picture(), content_type="image/png").status == 200
    assert server.person().post(f"/custom-emoji?name={name}", raw=picture(), content_type="image/png").status == 400
    for bad in ["x", "has-dash", "a" * 33]:
        assert person.post(f"/custom-emoji?name={bad}", raw=picture(), content_type="image/png").status == 400, bad


def test_at_most_24_custom_emoji_each(person):
    for n in range(24):
        reply = person.post(f"/custom-emoji?name={unique('many_')}", raw=picture(), content_type="image/png")
        assert reply.status == 200, n
    assert person.post(f"/custom-emoji?name={unique('many_')}", raw=picture(), content_type="image/png").status == 400


def test_replacing_an_emojis_picture_and_admins(server, owner):
    a = server.person()
    name = unique("swap_")
    a.post(f"/custom-emoji?name={name}", raw=picture(), content_type="image/png")
    with a.connect() as ws:
        emoji = next(e for e in ws.wait_for("custom_emoji")["emoji"] if e["name"] == name)
    assert server.person().post(f"/custom-emoji/{emoji['id']}/picture", raw=picture(), content_type="image/png").status == 404
    assert owner.post(f"/custom-emoji/{emoji['id']}/picture", raw=picture("JPEG"), content_type="image/jpeg").status == 200
    with a.connect() as ws:
        replaced = next(e for e in ws.wait_for("custom_emoji")["emoji"] if e["id"] == emoji["id"])
    assert replaced["name"] == name and replaced["file"] != emoji["file"]
    assert owner.delete(f"/custom-emoji/{emoji['id']}").status == 200  # admins: anyone's
