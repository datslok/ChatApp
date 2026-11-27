---
paths:
  - "scripts/**"
  - "serve.ps1"
  - "voice.ps1"
  - "livekit.yaml"
  - "desktop/src-tauri/tauri.conf.json"
  - "docs/guides/hosting.md"
  - "docs/guides/running.md"
  - "docs/notes/operations.md"
---

# Our own hosting

Our own addresses and setup, which the public guides leave out (they say example.com, "your PC" and "the server").
Committed like CLAUDE.md, so nothing private here: no local addresses, home folders or secrets.

The live site is https://chat.datslok.no, served from the separate server PC (`ssh chatserver`; set
up with `scripts\server\install.ps1`) through a Cloudflare Tunnel (`cloudflared` runs there as a
Windows service and forwards to http://localhost:8000; 2026.10.3 since 2026-10-26, for Cloudflare's emailed
eMudhra certificate fix: winget still offered 2026.10.0, so GitHub's MSI, checksum-checked; docs/guides/running.md,
"Updating cloudflared"). The domain is registered at domene.shop with its DNS on Cloudflare. `datslok.no`
itself is the landing page: a third route on the tunnel (`datslok.no` → http://localhost:8000) and
`LANDING_HOST=datslok.no` in the server's `.env`. Two Cloudflare Redirect Rules (302): "www to datslok.no"
(`www.datslok.no` → https://datslok.no) and "app to download" (`app.datslok.no` →
https://chat.datslok.no/download); their DNS records are proxied placeholders (A, 192.0.2.1), which must
stay for the rules to work.

Voice: the tunnel also carries `voice.datslok.no` → http://localhost:7880 (LiveKit's signalling; a
"published application route" in Cloudflare's Zero Trust dashboard, Networks → Tunnels → chatapp).
The audio can't go through the tunnel (UDP), so the router forwards UDP 7882 (`livekit_udp`) and
TCP 7881 (`livekit_tcp`) to the server PC (which has a DHCP reservation there), and two Windows
Firewall rules ("LiveKit voice (UDP 7882)" / "(TCP 7881)") let them in, only to `livekit\livekit-server.exe`.
The router's and the server PC's local addresses aren't written here (the repo is public): look them
up on the server (`ipconfig`, "Default Gateway" is the router) when needed.

SSH from outside the home network (set up 2026-11-08 for the laptop, for the UK trip): the server's firewall
allows port 22 only from `LocalSubnet` and the router doesn't forward it, so SSH goes through the tunnel:
route `ssh.datslok.no` → `ssh://localhost:22` (a loopback hop, so the firewall rule is unchanged), behind a
Cloudflare Access self-hosted application `ssh` (the user's email only, One-time PIN, 1-month session; the
"Cloudflare" login method failed with "Failed to fetch user/group information"). The laptop's `Host chatserver` uses
a `ProxyCommand` with `cloudflared access ssh --hostname %h` (its path: CLAUDE.local.md; copied from the server,
2026.10.3, hash and signature checked, while GitHub was down). When the session expires:
`cloudflared access login https://ssh.datslok.no`, interactively. The dev PC keeps its LAN-only entry.
From away, every release script runs with `-ViaGitHub` (since 2026-11-15; scp through the tunnel crawled and broke
off): `scripts/send-to-server.ps1` `Send-ToServer` puts the big files in a temporary pre-release `upload-<time>`,
the server curls them into .tmp, checks SHA-256, then moves them in place; the release is deleted in `finally`.
