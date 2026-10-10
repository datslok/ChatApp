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
   - [x] Friends: requests, friends list, list of all users; DMs only between friends
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
10. [ ] Voice channels with WebRTC/LiveKit
11. [ ] Video calls in DMs: 1-on-1, peer-to-peer WebRTC (signalling over our WebSocket, STUN/TURN),
    only between friends; mute, camera on/off, hang up
