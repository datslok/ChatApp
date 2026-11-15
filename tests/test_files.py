"""Files: uploads and who may download them, pictures and videos vs other files, profile pictures and
banners, and custom emoji."""
import io
import shutil
import subprocess

import pytest
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

def test_the_upload_limit_stays_under_cloudflares(server):
    """Cloudflare's Free plan refuses requests over 100 MB, and each upload is one request."""
    with server.person().connect() as ws:
        assert ws.wait_for("welcome")["limits"]["upload_size"] < 100_000_000


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


def made_video(tmp_path, name, sound):
    """A real one-second MP4 made by ffmpeg: a blue picture, with a tone or without any sound."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg isn't installed")
    path = tmp_path / name
    command = [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1"]
    if sound:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]
    command += ["-pix_fmt", "yuv420p", "-shortest", str(path)]
    subprocess.run(command, check=True)
    return path.read_bytes()


def test_a_video_says_whether_it_has_sound(server, channel, tmp_path):
    a = server.person()
    loud = upload(a, "tone.mp4", made_video(tmp_path, "tone.mp4", sound=True), "video/mp4")
    quiet = upload(a, "quiet.mp4", made_video(tmp_path, "quiet.mp4", sound=False), "video/mp4")
    unreadable = upload(a, "clip.mp4", b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200, "video/mp4")
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", files=[loud, quiet, unreadable])
        files = ws.wait_for("message")["files"]
    assert [file["audio"] for file in files] == [True, False, True]  # (not known: counted as sound)
    assert "audio" not in upload_info(a, channel)  # only videos say


def test_a_video_loses_its_metadata_but_not_its_rotation(server, channel, tmp_path):
    # A phone writes where a video was filmed into it, and which way up it is (a different thing:
    # "side data" on the picture's track, which must stay).
    ffmpeg = shutil.which("ffmpeg")
    plain = tmp_path / "plain.mp4"
    plain.write_bytes(made_video(tmp_path, "made.mp4", sound=False))  # (skips without ffmpeg)
    phone = tmp_path / "phone.mp4"
    subprocess.run([ffmpeg, "-v", "error", "-y", "-display_rotation", "90", "-i", str(plain), "-c", "copy",
                    "-metadata", "location=+59.9139+010.7522/", "-metadata", "comment=secret-note",
                    str(phone)], check=True)
    a = server.person()
    file_id, _ = sent_picture(a, channel, phone.read_bytes(), "video/mp4", "phone.mp4")
    sent = tmp_path / "sent.mp4"
    sent.write_bytes(a.get(f"/uploads/{file_id}").body)
    assert b"+59.9139" not in sent.read_bytes() and b"secret-note" not in sent.read_bytes()
    ffprobe = shutil.which("ffprobe")
    shown = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v", "-show_entries",
                            "stream_side_data=rotation", "-of", "csv=p=0", str(sent)],
                           capture_output=True, check=True).stdout
    assert b"90" in shown  # (-90 or 90, as ffprobe writes it)


def upload_info(person, channel):
    """A text file's info as a message brings it."""
    file_id = upload(person, "notes.txt", b"hello", "text/plain")
    with person.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", files=[file_id])
        return ws.wait_for("message")["files"][0]


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


# ----- Thumbnails

def sent_picture(person, channel, data, content_type="image/png", name="big.png"):
    """Upload a picture and send it in `channel`; returns (file id, message id)."""
    file_id = upload(person, name, data, content_type)
    with person.connect() as ws:
        ws.join(channel)
        ws.send(type="message", text="", files=[file_id])
        return file_id, ws.wait_for("message")["id"]


def opened(reply):
    return Image.open(io.BytesIO(reply.body))


def test_a_picture_comes_at_the_size_asked_for(server, channel):
    a, b = server.person(), server.person()
    file_id, _ = sent_picture(a, channel, picture(size=(1000, 500)))
    small = b.get(f"/uploads/{file_id}?size=200")
    assert small.status == 200 and small.headers["Content-Type"] == "image/webp"
    assert small.headers["Content-Disposition"].startswith("inline")
    assert opened(small).size == (200, 100)  # its longest side, the shape kept
    assert opened(b.get(f"/uploads/{file_id}")).size == (1000, 500)  # the original is still there
    assert b.get(f"/uploads/{file_id}?size=123").status == 400  # only the server's sizes
    assert Client().get(f"/uploads/{file_id}?size=200").status == 404  # the same rule as the original


def test_a_small_picture_comes_as_it_is(server, channel):
    a = server.person()
    file_id, _ = sent_picture(a, channel, picture(size=(300, 300)))
    reply = a.get(f"/uploads/{file_id}?size=400")
    assert reply.headers["Content-Type"] == "image/png" and opened(reply).size == (300, 300)


def test_other_files_ignore_the_size(server, channel):
    a = server.person()
    file_id, _ = sent_picture(a, channel, b"hello", "text/plain", "notes.txt")
    assert a.get(f"/uploads/{file_id}?size=200").body == b"hello"


def test_a_sideways_photo_is_turned_upright(server, channel):
    # Cameras save a portrait photo as a landscape one with EXIF orientation 6 ("turn me 90°").
    image = Image.new("RGB", (800, 600), (200, 100, 50))
    exif = Image.Exif()
    exif[0x0112] = 6
    out = io.BytesIO()
    image.save(out, format="JPEG", exif=exif)
    a = server.person()
    file_id, _ = sent_picture(a, channel, out.getvalue(), "image/jpeg", "photo.jpg")
    assert opened(a.get(f"/uploads/{file_id}?size=400")).size == (300, 400)


def test_an_animation_stays_animated(server, channel):
    a = server.person()
    file_id, _ = sent_picture(a, channel, picture("GIF", size=(600, 300), frames=3), "image/gif", "dance.gif")
    small = opened(a.get(f"/uploads/{file_id}?size=200"))
    assert small.format == "WEBP" and small.size == (200, 100) and small.n_frames == 3


def test_an_iphone_photo_is_no_animation(server, channel):
    # iPhones save photos as MPO: a JPEG with a second, small and dark picture after it (the HDR gain
    # map). Pillow counts two frames, and the thumbnail used to flash between the photo and black.
    photo, gain_map = Image.new("RGB", (800, 600), (40, 160, 60)), Image.new("RGB", (200, 150), (0, 0, 0))
    out = io.BytesIO()
    photo.save(out, format="MPO", save_all=True, append_images=[gain_map])
    a = server.person()
    file_id, _ = sent_picture(a, channel, out.getvalue(), "image/jpeg", "IMG_4543.jpeg")
    small = opened(a.get(f"/uploads/{file_id}?size=400"))
    assert small.format == "WEBP" and small.size == (400, 300)
    assert getattr(small, "n_frames", 1) == 1
    assert small.convert("RGB").getpixel((200, 150))[1] > 100  # the photo (green), not the gain map


# ----- Metadata

def phone_exif(orientation=None):
    """EXIF like a phone's: the phone, the owner, when and where (GPS), and maybe an orientation."""
    exif = Image.Exif()
    exif[0x010F] = "SecretPhone"     # Make
    exif[0x013B] = "Secret Owner"    # Artist
    exif[0x0132] = "2026:11:15 10:14:00"  # DateTime
    if orientation:
        exif[0x0112] = orientation
    gps = exif.get_ifd(0x8825)       # the GPS part
    gps[1], gps[2] = "N", (59.0, 54.0, 50.0)
    gps[3], gps[4] = "E", (10.0, 45.0, 8.0)
    return exif


def sent_original(person, channel, data, content_type, name):
    """Send a picture and download it back as anyone would (the original, not a thumbnail)."""
    file_id, _ = sent_picture(person, channel, data, content_type, name)
    return person.get(f"/uploads/{file_id}").body


def test_a_jpeg_loses_its_metadata_but_not_its_pixels_or_orientation(server, channel):
    image = Image.effect_noise((300, 200), 60).convert("RGB")  # (noise: every pixel different)
    out = io.BytesIO()
    image.save(out, format="JPEG", exif=phone_exif(orientation=6), comment=b"secret comment", quality=90,
               icc_profile=b"\x00" * 128)
    original = out.getvalue()
    xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>secret-xmp</x:xmpmeta>"
    original = original[:2] + b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp + original[2:]
    sent = sent_original(server.person(), channel, original, "image/jpeg", "photo.jpg")
    for secret in (b"SecretPhone", b"Secret Owner", b"2026:11:15", b"secret comment", b"secret-xmp"):
        assert secret not in sent
    picture = opened_bytes(sent)
    exif = picture.getexif()
    assert dict(exif) == {0x0112: 6} and not exif.get_ifd(0x8825)  # only which way up; no GPS
    assert picture.info.get("icc_profile") == b"\x00" * 128  # the colour profile stays
    assert picture.tobytes() == opened_bytes(original).tobytes()  # cut, not saved again: the same pixels


def test_an_iphone_photo_comes_as_one_picture(server, channel):
    photo, gain_map = Image.new("RGB", (400, 300), (40, 160, 60)), Image.new("RGB", (100, 75), (0, 0, 0))
    out = io.BytesIO()
    photo.save(out, format="MPO", save_all=True, append_images=[gain_map], exif=phone_exif())
    picture = opened_bytes(sent_original(server.person(), channel, out.getvalue(), "image/jpeg", "IMG.jpeg"))
    assert picture.format == "JPEG" and getattr(picture, "n_frames", 1) == 1 and not dict(picture.getexif())


def test_a_png_loses_its_text_and_exif(server, channel):
    from PIL.PngImagePlugin import PngInfo
    notes = PngInfo()
    notes.add_text("Location", "secret-place")
    notes.add_itxt("Author", "secret-author")
    out = io.BytesIO()
    image = Image.new("RGBA", (64, 64), (10, 20, 30, 128))
    image.save(out, format="PNG", pnginfo=notes, exif=phone_exif())
    sent = sent_original(server.person(), channel, out.getvalue(), "image/png", "screenshot.png")
    assert b"secret-place" not in sent and b"secret-author" not in sent and b"SecretPhone" not in sent
    assert opened_bytes(sent).tobytes() == image.tobytes()


def test_a_webp_loses_its_exif_and_xmp(server, channel):
    out = io.BytesIO()
    image = Image.new("RGB", (64, 64), (200, 30, 30))
    image.save(out, format="WEBP", exif=phone_exif(), xmp=b"<x:xmpmeta>secret-xmp</x:xmpmeta>", lossless=True)
    sent = sent_original(server.person(), channel, out.getvalue(), "image/webp", "picture.webp")
    assert b"SecretPhone" not in sent and b"secret-xmp" not in sent
    assert sent[20] & 0x0C == 0  # the VP8X flags no longer announce EXIF or XMP
    picture = opened_bytes(sent)
    assert not dict(picture.getexif()) and picture.convert("RGB").tobytes() == image.tobytes()


def opened_bytes(data):
    return Image.open(io.BytesIO(data))


def test_deleting_the_message_deletes_its_thumbnails(server, channel):
    a = server.person()
    file_id, message_id = sent_picture(a, channel, picture(size=(1000, 1000)))
    assert a.get(f"/uploads/{file_id}?size=400").status == 200
    thumbnail = server.work / "uploads" / "thumbs" / f"{file_id}-400.webp"
    assert thumbnail.exists()
    with a.connect() as ws:
        ws.join(channel)
        ws.send(type="delete", message_id=message_id)
        ws.wait_for("deleted")
    assert not thumbnail.exists()


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
        for n, files in enumerate([ids, [ids[0], ids[0]], "not a list", [17]]):
            ws.send(type="message", text="files", files=files, nonce=f"bad{n}")
            assert ws.wait_for("not_sent")["nonce"] == f"bad{n}"
        assert len(ws.say("ten", files=ids[:10])["files"]) == 10


def test_an_empty_list_of_files_is_a_text_message(server, channel):
    """The phone app sends "files": [] with every text message (connection.js sendMessage)."""
    a = server.person()
    with a.connect() as ws:
        ws.join(channel)
        assert ws.say("just words", files=[])["files"] == []
        ws.send(type="message", text="", files=[], nonce="empty")  # nothing at all: still refused
        assert ws.wait_for("not_sent")["nonce"] == "empty"


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
