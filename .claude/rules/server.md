---
paths:
  - "server.py"
  - "chatapp/**"
  - "tests/**"
  - "chattus.py"
---

# The server and its tests

How it's built: `docs/notes/server.md`.

- **Layers:** a `chatapp/` module imports only from lower layers, never `server.py`. Names are imported explicitly
  (`from chatapp.db import db`, never `import *`). No module reassigns another's global: background starters are
  functions in their own module.
- **Limits the pages need are written only in the server's `LIMITS`** (sent in "welcome"). Never copy such a number
  into a page or the phone app: add it to `LIMITS`. Page-design numbers stay in the pages.
- **Tests:** run `test.ps1` after every server change; add tests with features and fixes. A new test is seen to fail
  first: break the code it guards, watch it fail, undo the break.
- **The tests are black-box only:** they talk to a throwaway server over HTTP and WebSockets, and never import
  `server.py` or `chatapp/` (a hook blocks that).
- **Security basics:** hash passwords with argon2, check every input at the route, and never trust what a page says
  about who it is.
- **Privacy:** the device a message was sent from (`sent_from`) goes to bots only. The owner and bots see every
  channel, other admins don't; hidden roles never reach non-admins (`docs/notes/channels-and-roles.md`).
