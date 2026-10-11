# Roadmap

1. [x] One chat room: WebSocket broadcast to everyone connected
   - [x] Display names (typed in, remembered in the browser; real accounts come in milestone 4)
2. [x] Save messages in SQLite and load history when someone joins
3. [x] Channels (#general, #memes, …) and a sidebar to switch between them
4. [x] Accounts and login (hashed passwords, sessions)
   - [x] Email per account, password reset by email, Settings (change username, email, password)
   - [x] People identified by user id behind the scenes, so usernames can change
   - [x] Profiles: picture and banner (with a move/zoom editor), status, bio, profile popup
   - [x] Animated GIFs as picture and banner (cropped frame by frame on the server with Pillow)
5. [x] Online list and "is typing…" indicator
6. [x] Direct messages: private two-person channels, opened from the sidebar
   - [x] Friends: requests and a friends list (a page in the chat area, like Discord); DMs only between friends
   - [x] Online and offline people in the right column
7. [x] Image and file uploads (with a preview tray, drag-and-drop and pasting)
8. [x] Host it so friends can connect: live at https://chat.datslok.no through a Cloudflare Tunnel
   - [x] Before going online: invite code for new accounts, login limits, HTTPS (wss://, secure cookies)
   - [x] Mobile-friendly layout (drawers for channels and the online list)
   - [x] Separate development database (dev.db), so tests stay out of the real chat
9. [x] Nice-to-haves, in this order:
   - [x] Unread dots on channels and DMs (remembered by the server)
   - [x] Message ids and times on the page, message grouping and date dividers
   - [x] Replies
   - [x] Reactions, with a full emoji picker (from Unicode's emoji list)
   - [x] Custom emoji (12 per person, also animated) as reactions
   - [x] Editing and deleting your own messages; admins can edit and delete anyone's (tools/make_admin.py)
   - [x] @mentions and @everyone (stored by user id), with a red unread count per channel
   - [x] Notifications for DMs and mentions (desktop notifications, a generated sound, count in the tab title)
   - [x] Custom emoji inside messages (typing :pog:, stored as <:id> tokens); emoji picker and jumbo emoji in messages; multi-line text box
   - [x] Desktop app via Tauri (Windows installer, real notifications, automatic updates)
10. [x] Voice with WebRTC, through our own LiveKit server (self-hosted on this PC)
    - [x] LiveKit server (voice.ps1), reachable at voice.datslok.no (tunnel) with UDP/TCP forwarded on the router
    - [x] Voice tickets from our server (/voice-token: a JWT signed with the standard library)
    - [x] Lounge voice channel: join, mute, leave
    - [x] Voice settings: input and output device, mic and output volume, sensitivity (noise gate, with dB numbers)
    - [x] Volume per person (in the profile popup, 0-200%)
    - [x] Who is in voice (in the sidebar, with 🔇 for muted) and a speaking ring
    - [x] Calls in DMs: ringing on every device, accept/decline, call notes in the DM
    - [x] Call banner in the DM (both pictures with speaking rings, mute, end call, Join call)
    - [x] Sounds: calling, ringing, join and leave cues
    - [x] Voice in the desktop app
    - [x] Incoming call notifications in the desktop app
11. [x] Video in calls and Lounge: camera on/off (through our LiveKit server, like voice)
    - [x] Camera button, and video in the DM call banner
    - [x] A Lounge page with a tile for everyone (video or picture)
    - [x] Choosing the camera in Settings, with a preview
12. [x] Screen sharing in calls and Lounge (through LiveKit, like the camera): 720p/1080p/1440p, 30/60 fps, with sound
13. [x] Start the chat (serve.ps1) and voice (voice.ps1) automatically with Windows, without open windows
    - [x] Scripts to run the server on its own PC (scripts\server\: install, export, import, update; scheduled tasks; README)
    - [x] Set up on the laptop and tested (a restart brings everything back by itself)
14. [x] Backups of chat.db and uploads/: nightly onto the server PC's second disk (30 days), and a copy fetched to the development PC
15. [ ] Everyday chat gaps, in this order:
    - [x] Clickable links in messages
    - [ ] Loading older messages when scrolling up (past the newest 50)
    - [ ] Text formatting: **bold**, *italic*, `code`, code blocks, > quotes, ||spoilers||, ~~strikethrough~~
    - [ ] Link previews (title and picture for pasted links, fetched safely by the server)
16. [ ] Organising the chat
    - [ ] Admins create, rename, delete and reorder channels from the app, with headings to group them
    - [ ] Group DMs (private chats with 3-10 people)
    - [ ] Pinned messages per channel
    - [ ] Search messages (by text, person or channel; SQLite's FTS5)
17. [ ] Social and presence
    - [ ] Statuses: Online, Idle (automatic when away), Do Not Disturb (no notifications), Invisible
    - [ ] Muting a channel or DM
    - [ ] Blocking someone
    - [ ] Roles with colours (coloured names and headings in the member list)
18. [ ] Smaller polish
    - [x] Clicking a reply's quote jumps to the original message (was already there)
    - [ ] Up arrow in an empty text box edits your last message
    - [ ] A "New messages" divider where you stopped reading
    - [ ] GIF search (Tenor or Giphy)
    - [ ] Soundboard in voice
    - [ ] Push-to-talk, as an alternative to the noise gate
