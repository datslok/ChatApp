# Roadmap

1. [x] One chat room: WebSocket broadcast to everyone connected
   - [x] Display names (typed in, remembered in the browser; real accounts come in milestone 4)
2. [x] Save messages in SQLite and load history when someone joins
3. [x] Channels (#general, #memes, …) and a sidebar to switch between them
4. [x] Accounts and login (hashed passwords, sessions)
5. [x] Online list and "is typing…" indicator
6. [x] Direct messages: private two-person channels, opened from the sidebar
7. [ ] Image and file uploads
8. [ ] Host it so friends can connect (VPS, or a Cloudflare Tunnel/Tailscale)
   - Before going online: require an invite code to create an account, and limit login attempts
9. [ ] Voice channels with WebRTC/LiveKit
10. [ ] Nice-to-haves: reactions, replies, mentions, notifications (e.g. unread DMs), desktop app via Tauri
