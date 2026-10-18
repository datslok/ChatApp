"""Accounts: invites, signing up, verifying the email, logging in and out, resetting a password, and the
account settings (name, email, password)."""
from conftest import PASSWORD, Client, Person, unique, verify


# ----- Invites and signing up

def test_signing_up_needs_an_invite(server):
    person, reply = server.register(unique("noinvite"), invite="")
    assert reply.status == 403
    assert "invite" in reply.detail


def test_a_made_up_invite_is_refused(server):
    person, reply = server.register(unique("fake"), invite="not-a-real-code")
    assert reply.status == 403


def test_an_invite_works_once(server):
    code = server.invite()
    first, reply = server.register(unique("first"), invite=code)
    assert reply.status == 200
    second, reply = server.register(unique("second"), invite=code)
    assert reply.status == 403


def test_invite_info_tells_whose_invite_it_is(server):
    code = server.invite()
    info = Client().get(f"/invite-info?code={code}").json
    assert info == {"required": True, "given": True, "valid": True, "inviter": "owner"}
    assert Client().get("/invite-info?code=nope").json["valid"] is False


def test_the_invite_link_keeps_the_code_as_a_cookie(server):
    code = server.invite()
    visitor = Client()
    reply = visitor.get(f"/invite/{code}", follow=False)
    assert reply.status in (302, 307)
    assert visitor.cookie("invite") == code
    # The cookie is enough to sign up with (the landing page's "Create your account").
    assert visitor.get("/invite-info").json["valid"] is True


def test_invites_can_be_listed_and_cancelled(person):
    code = person.post("/invites").json["invites"][0]["code"]
    assert [invite["code"] for invite in person.get("/invites").json["invites"]] == [code]
    assert person.post(f"/invites/{code}/cancel").json["invites"] == []


def test_at_most_ten_open_invites(person):
    for _ in range(10):
        assert person.post("/invites").status == 200
    assert person.post("/invites").status == 400


def test_someone_elses_invite_cant_be_cancelled(server, person):
    code = server.invite()
    person.post(f"/invites/{code}/cancel")
    assert Client().get(f"/invite-info?code={code}").json["valid"] is True


def test_usernames_are_checked(server):
    for name in ["has space", "x" * 33, "everyone", "with/slash"]:
        person, reply = server.register(name, email=f"{unique('bad')}@example.com")
        assert reply.status == 400, name


def test_a_taken_username_or_email_is_refused(server, person):
    _, reply = server.register(person.name, email=f"{unique('other')}@example.com")
    assert reply.status == 400 and "username" in reply.detail
    _, reply = server.register(unique("sameemail"), email=person.email)
    assert reply.status == 400 and "email" in reply.detail


def test_short_passwords_and_bad_emails_are_refused(server):
    person = Person(unique("short"), "short@example.com", "10.1.1.1")
    reply = person.post("/register", {"username": person.name, "password": "1234567",
                                      "email": person.email, "invite": server.invite()})
    assert reply.status == 400
    reply = person.post("/register", {"username": person.name, "password": PASSWORD,
                                      "email": "not-an-email", "invite": server.invite()})
    assert reply.status == 400


# ----- Verifying the email

def test_an_unverified_account_is_logged_out_everywhere_but_the_verify_page(server):
    person, reply = server.register(unique("unverified"))
    assert reply.status == 200
    assert person.get("/me").status == 401
    status = person.get("/verify/status").json
    assert status["logged_in"] is True and status["verified"] is False
    with person.connect() as ws:
        try:
            ws.wait_for("welcome", timeout=1)
            raise AssertionError("an unverified account got into the chat")
        except Exception as error:  # the server closes the WebSocket with 4001
            assert "4001" in str(error) or "No 'welcome'" in str(error)
    # The link in the email lets it in.
    verify(server, person)
    assert person.get("/me").status == 200


def test_a_wrong_address_can_be_fixed_before_verifying(server):
    person, _ = server.register(unique("typo"))
    new_address = f"{unique('fixed')}@example.com"
    reply = person.post("/verify/change", {"email": new_address})
    assert reply.status == 200 and reply.json["email"] == new_address
    person.email = new_address
    verify(server, person)


def test_a_used_verification_link_says_expired(server):
    person, _ = server.register(unique("twice"))
    link = server.email_link(person.email, "/verify")
    person.get(link)
    reply = person.get(link, follow=False)
    assert "expired" in reply.headers["location"]


def test_verification_emails_are_limited(server):
    person, _ = server.register(unique("flood"))  # the first email counts too
    answers = [person.post("/verify/resend").status for _ in range(5)]
    assert answers[:4] == [200] * 4 and answers[4] == 429


# ----- Logging in and out

def test_login_and_logout(person):
    fresh = Person(person.name, person.email, "10.2.2.2")
    assert fresh.get("/me").status == 401
    assert fresh.post("/login", {"username": person.name, "password": PASSWORD}).status == 200
    assert fresh.get("/me").json["username"] == person.name
    assert fresh.get("/whoami").json["username"] == person.name
    assert fresh.post("/logout").status == 200
    assert fresh.get("/me").status == 401
    assert fresh.get("/whoami").json == {"username": None}


def test_a_logged_out_session_stops_working_even_if_copied(person):
    copy = Client()
    copy.cookies = person.cookies  # the same cookie jar: the same session token
    token = person.cookie("session")
    person.post("/logout")
    thief = Client()
    reply = thief.get("/me", headers={"Cookie": f"session={token}"})
    assert reply.status == 401


def test_wrong_password_and_unknown_user_get_the_same_answer(person):
    stranger = Client()
    wrong = stranger.post("/login", {"username": person.name, "password": "wrong-password"})
    unknown = stranger.post("/login", {"username": unique("nobody"), "password": "wrong-password"})
    assert wrong.status == unknown.status == 401
    assert wrong.detail == unknown.detail


def test_five_wrong_passwords_lock_the_name_for_a_while(person):
    stranger = Client()
    for _ in range(5):
        assert stranger.post("/login", {"username": person.name, "password": "wrong"}).status == 401
    # Locked: even the right password is refused now.
    assert stranger.post("/login", {"username": person.name, "password": PASSWORD}).status == 429


def test_the_websocket_refuses_strangers(server):
    with Client().connect() as ws:
        try:
            ws.wait_for("welcome", timeout=1)
            raise AssertionError("a stranger got into the chat")
        except Exception as error:
            assert "4001" in str(error) or "No 'welcome'" in str(error)


# ----- Resetting a forgotten password

def test_resetting_a_password(server, person):
    assert Client().post("/forgot", {"email": person.email}).status == 200
    link = server.email_link(person.email, "/reset")
    token = link.split("token=")[1]
    assert Client().post("/reset", {"token": token, "password": "a-brand-new-password"}).status == 200
    # Every session is logged out, the old password stops working, the new one works.
    assert person.get("/me").status == 401
    fresh = Client()
    assert fresh.post("/login", {"username": person.name, "password": PASSWORD}).status == 401
    assert fresh.post("/login", {"username": person.name, "password": "a-brand-new-password"}).status == 200
    # The link works once.
    assert Client().post("/reset", {"token": token, "password": "yet-another-password"}).status == 400


def test_forgot_answers_the_same_for_unknown_emails(server):
    assert Client(ip="10.3.3.3").post("/forgot", {"email": f"{unique('ghost')}@example.com"}).status == 200


# ----- Account settings

def test_me(person):
    me = person.get("/me").json
    assert me["username"] == person.name and me["email"] == person.email
    assert me["pending_email"] is None


def test_changing_the_username(server, person):
    new_name = unique("renamed")
    assert person.post("/settings/username", {"username": new_name, "password": "wrong"}).status == 403
    with server.owner.connect() as ws:
        ws.drain()
        reply = person.post("/settings/username", {"username": new_name, "password": PASSWORD})
        assert reply.status == 200
        # Every page hears it, so old messages show the new name too.
        renamed = ws.wait_for("renamed", lambda message: message["id"] == person.id)
        assert renamed["username"] == new_name
    assert person.get("/me").json["username"] == new_name
    taken = person.post("/settings/username", {"username": "owner", "password": PASSWORD})
    assert taken.status == 400


def test_changing_the_email_waits_for_the_new_address(server, person):
    new_address = f"{unique('moved')}@example.com"
    reply = person.post("/settings/email", {"email": new_address, "password": PASSWORD})
    assert reply.json == {"ok": True, "email": person.email, "pending": new_address}
    assert person.get("/me").json["email"] == person.email  # the old one until the link is clicked
    assert person.get(server.email_link(new_address, "/verify")).status == 200
    me = person.get("/me").json
    assert me["email"] == new_address and me["pending_email"] is None


def test_a_waiting_email_change_can_be_cancelled(person):
    person.post("/settings/email", {"email": f"{unique('maybe')}@example.com", "password": PASSWORD})
    assert person.post("/settings/email/cancel").status == 200
    assert person.get("/me").json["pending_email"] is None


def test_changing_the_password_logs_out_other_devices(person):
    other_device = Client()
    other_device.post("/login", {"username": person.name, "password": PASSWORD})
    assert other_device.get("/me").status == 200
    reply = person.post("/settings/password", {"current_password": PASSWORD, "new_password": "changed-password-1"})
    assert reply.status == 200
    assert person.get("/me").status == 200  # this one stays logged in
    assert other_device.get("/me").status == 401
    wrong = person.post("/settings/password", {"current_password": PASSWORD, "new_password": "whatever-123"})
    assert wrong.status == 403
