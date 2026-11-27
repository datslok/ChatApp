# Accounts, admins and invites

Covers: `chatapp/accounts.py`, `chatapp/admin.py`, `static/login.html`, `static/reset.html`, `static/verify.html`, `tools/make_admin.py`, `tools/feedback.py`

How accounts come to be and are run: emails, the first admin, invites and email verification, bans and the
owner, the feedback inbox and Settings → Admin. The server side is in `accounts.py` and `admin.py` (see
[server.md](server.md)).

## Emails

Emails (such as reset links) go out through Resend's SMTP server, configured in `.env`. Without `SMTP_HOST`
(as in development) they're printed in the server window instead.

## Admins

- The first account on an empty server (bots don't count) becomes admin by itself. `/register` decides this
  inside the INSERT.
- `tools/make_admin.py` makes someone an admin. Options: `--remove`, `--list`, and `--db dev.db` for
  development.
- Admins can edit and delete anyone's messages and custom emoji, and manage the channels (see
  [channels-and-roles.md](channels-and-roles.md)).

## Invites and email verification

`accounts.py`, "Invites" and "Email verification". Since 2026-10-14, replacing the old INVITE_CODE.

### Invites

- `/register` needs an unused invite. The `invites` table has code, created_by and used_by.
  - Each invite has one use and lasts `INVITE_DAYS` 7 days; each person may have `MAX_OPEN_INVITES` 10 open.
  - The invite is checked and used up in the same transaction as the INSERT.
  - Not needed when `REQUIRE_INVITE=0` (dev.env; serve.ps1 refuses it), or when nobody has an account yet.
- `/invite/<code>` sets the HttpOnly cookie "invite" (a week) and redirects to the landing page
  (`https://LANDING_HOST/`, else /welcome). The user's wish: people read the features first.
- The landing page's script asks `/invite-info` (CORS like /whoami) and shows "x invited you" + Create your
  account (`/login?register`).
- `invite_code` (an explicit code, else the cookie) is used by /invite-info and /register. /register deletes the
  cookie.
- /invite-info's `given` lets login.html say "doesn't work any more".
- On the page: People page → Invite someone (#invite-dialog, people.js "Invites"; see [people.md](people.md)).

### Email verification

- New accounts get `email_verified` 0 and a link: `email_verifications` holds a hashed token + the address, valid
  `VERIFY_HOURS` 24 hours.
- `user_id_from_token` only accepts verified accounts, so an unverified one is "logged out" everywhere except
  static/verify.html (`/verify-email`, `/verify/status`, `/verify/resend`, `/verify/change`). `/` and `/login`
  redirect there.
- Unverified accounts are missing from `users_message`.
- Existing accounts and bots count as verified (the column's DEFAULT 1).
- A new email from Settings waits in `pending_email` until its link is clicked. Then the old address gets the
  security notice.
- At most 5 verification emails per account per 15 min (`verify:<id>` in `failures`).

## Bans and the owner

`admin.py`, "Bans and admins"; people.js "Banning"; settings.js "Admin → Bans/Admins".

### The columns

- `users.is_owner`: the first account, set in /register's INSERT like is_admin. On older servers it's the
  oldest non-bot admin.
- `banned_at`/`banned_until` (NULL = for good; otherwise 1, 7 or 30 days)/`banned_by`/`ban_reason`.

### Where a ban is checked

`BANNED_NOW` (SQL) is checked by:

- `session_user`, so banned = logged out;
- `users_message`, so they're out of the lists;
- `ban_message`, /login's answer (given after the password).

### Banning

`/admin/ban` refuses (`ban_refusal`) to ban yourself, bots or the owner; admins can be banned only by the owner.
A ban also takes admin away. It:

- deletes their sessions and open invites;
- removes them from LiveKit rooms (`remove_from_voice`, RoomService/RemoveParticipant with a roomAdmin JWT; see
  [voice.md](voice.md));
- closes their pages.

The other routes: `/admin/unban`, `/admin/bans`, and `/admin/admins` (owner only).

On the page: Ban… in the user menu (`mayBan`), #ban-dialog, and Settings → Admin → Bans and Admins (the
owner's sub-tab).

## Bugs & ideas (feedback)

- Settings → "Bugs & ideas": `/feedback` saves a report in the `feedback` table and emails it to every admin
  with an email.
- Admins read them in Settings → Admin → Inbox (settings.js; `GET /feedback` and `POST /feedback/{id}/done`, both
  admin-only on the server).
- Or with `tools/feedback.py` (`--all`, `--done ID`, `--undo ID`, `--db dev.db`).

## Settings → Admin

settings.js, "Admin"; only for `amAdmin()`.

- One tab, "Admin (n)", where n is the number of open bug reports.
- Its page has sub-tabs (`.admin-tab`, `showAdminSection`) for the sections Inbox, Channels, Roles and Invites.
- Invites shows everyone's open links with ×, and who joined with whose (`GET /admin/invites`,
  `/admin/invites/{code}/cancel`, `logged_in_admin`).
- Bans and Admins: see [Bans and the owner](#bans-and-the-owner).

**New admin tools go there as another section.**
