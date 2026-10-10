# Roadmap

1. [x] One chat room: WebSocket broadcast to everyone connected
   - [x] Display names (typed in, remembered in the browser; real accounts come in milestone 4)
2. [x] Save messages in SQLite and load history when someone joins
3. [x] Channels (#general, #memes, …) and a sidebar to switch between them
4. [x] Accounts and login (hashed passwords, sessions)
   - [x] Email per account, password reset by email, Settings (change username, email, password)
   - [x] People identified by user id behind the scenes, so usernames can change
   - [x] Profiles: picture and banner (with a move/zoom editor), status, bio, profile popup
5. [x] Online list and "is typing…" indicator
6. [x] Direct messages: private two-person channels, opened from the sidebar
7. [x] Image and file uploads (with a preview tray, drag-and-drop and pasting)
8. [x] Host it so friends can connect: live at https://chat.datslok.no through a Cloudflare Tunnel
   - [x] Before going online: invite code for new accounts, login limits, HTTPS (wss://, secure cookies)
   - [x] Mobile-friendly layout (drawers for channels and the online list)
   - [x] Separate development database (dev.db), so tests stay out of the real chat
9. [ ] Voice channels with WebRTC/LiveKit
10. [ ] Nice-to-haves: reactions, replies, mentions, notifications, desktop app via Tauri
    - [x] Unread dots on channels and DMs (remembered by the server)
