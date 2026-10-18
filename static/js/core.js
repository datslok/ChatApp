// The page's elements, connecting to the server, the server's messages, switching
// channels, and the sidebar.
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// Grab the HTML elements we need, by their id.
const channelList = document.getElementById("channel-list");
const dmList = document.getElementById("dm-list");
const logoutButton = document.getElementById("logout");
const settingsButton = document.getElementById("settings-button");
const settingsDialog = document.getElementById("settings");
const profileForm = document.getElementById("profile-form");
const settingsAvatar = document.getElementById("settings-avatar");
const changeAvatarButton = document.getElementById("change-avatar");
const removeAvatarButton = document.getElementById("remove-avatar");
const avatarInput = document.getElementById("avatar-input");
const statusInput = document.getElementById("status-input");
const bioInput = document.getElementById("bio-input");
const profileStatusLine = document.getElementById("profile-status-line");
const settingsBanner = document.getElementById("settings-banner");
const emojiCount = document.getElementById("emoji-count");
const myEmojiList = document.getElementById("my-emoji");
const emojiNameInput = document.getElementById("emoji-name");
const addEmojiButton = document.getElementById("add-emoji");
const emojiInput = document.getElementById("emoji-input");
const emojiStatus = document.getElementById("emoji-status");
const notifyDesktopBox = document.getElementById("notify-desktop");
const notifySoundBox = document.getElementById("notify-sound");
const notifyHelp = document.getElementById("notify-help");
const notifyVolumeSlider = document.getElementById("notify-volume");
const notifyVolumeValue = document.getElementById("notify-volume-value");
const muteSelect = document.getElementById("mute-select");
const muteStatus = document.getElementById("mute-status");
const mutedIcon = document.getElementById("muted-icon");
const changeBannerButton = document.getElementById("change-banner");
const removeBannerButton = document.getElementById("remove-banner");
const bannerInput = document.getElementById("banner-input");
const profileBanner = document.getElementById("profile-banner");
const cropTitle = document.getElementById("crop-title");
const cropperDialog = document.getElementById("cropper");
const cropFrame = document.getElementById("crop-frame");
const cropCanvas = document.getElementById("crop-canvas");
const cropGif = document.getElementById("crop-gif");
const cropZoom = document.getElementById("crop-zoom");
const cropCancel = document.getElementById("crop-cancel");
const cropSave = document.getElementById("crop-save");
const profileDialog = document.getElementById("profile");
const profileClose = document.getElementById("profile-close");
const profileAvatar = document.getElementById("profile-avatar");
const profileName = document.getElementById("profile-name");
const profileStatus = document.getElementById("profile-status");
const profileBio = document.getElementById("profile-bio");
const profileActions = document.getElementById("profile-actions");
const profileActionStatus = document.getElementById("profile-action-status");
const friendsButton = document.getElementById("friends-button");
const requestBadge = document.getElementById("request-badge");
const friendsView = document.getElementById("friends-view");
const channelView = document.getElementById("channel-view");
const peopleList = document.getElementById("people-list");
const peopleFilter = document.getElementById("people-filter");
const peopleStatus = document.getElementById("people-status");
const requestsTabCount = document.getElementById("requests-tab-count");
const usernameForm = document.getElementById("username-form");
const currentUsername = document.getElementById("current-username");
const newUsernameInput = document.getElementById("new-username");
const usernamePasswordInput = document.getElementById("username-password");
const usernameStatus = document.getElementById("username-status");
const settingsClose = document.getElementById("settings-close");
const emailForm = document.getElementById("email-form");
const currentEmail = document.getElementById("current-email");
const newEmailInput = document.getElementById("new-email");
const emailPasswordInput = document.getElementById("email-password");
const emailStatus = document.getElementById("email-status");
const passwordForm = document.getElementById("password-form");
const currentPasswordInput = document.getElementById("current-password");
const newPasswordInput = document.getElementById("new-password");
const newPasswordAgainInput = document.getElementById("new-password-again");
const passwordStatus = document.getElementById("password-status");
const messages = document.getElementById("messages");
const typingLine = document.getElementById("typing");
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const botsHeading = document.getElementById("bots-heading");
const botsList = document.getElementById("bots-list");
const onlineHeading = document.getElementById("online-heading");
const onlineList = document.getElementById("online-list");
const offlineHeading = document.getElementById("offline-heading");
const offlineList = document.getElementById("offline-list");
const banner = document.getElementById("banner");
const chat = document.getElementById("chat");
const sidebarElement = document.getElementById("sidebar");
const membersElement = document.getElementById("members");
const topbarTitle = document.getElementById("topbar-title");
const openSidebarButton = document.getElementById("open-sidebar");
const openMembersButton = document.getElementById("open-members");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const attachButton = document.getElementById("attach-button");
const fileInput = document.getElementById("file-input");
const uploadStatus = document.getElementById("upload-status");
const dropOverlay = document.getElementById("drop-overlay");
const trayElement = document.getElementById("tray");
const replyBar = document.getElementById("reply-bar");
const replyName = document.getElementById("reply-name");
const replyCancel = document.getElementById("reply-cancel");
const viewer = document.getElementById("image-viewer");
const viewerImage = document.getElementById("viewer-image");
const viewerClose = document.getElementById("viewer-close");

let socket = null;         // our WebSocket (replaced with a new one if it drops)
let currentChannel = null;  // the channel (or DM) we're looking at
let firstChannel = null;    // where to start: the first channel in the list
// The sidebar's channels and headings, top to bottom, from the server:
// [{key: "general", name: "general", heading: false}, {key: "h:9c1e...", name: "Games", heading: true}, ...]
// A channel's key never changes (messages point to it); its name is what we show.
let channels = [];
let loungeAllowed = true;  // false for someone with a limited role: no Lounge (channelsChanged)
const voiceHeading = document.getElementById("voice-heading");
const voiceList = document.getElementById("voice-list");
// The People page (called Friends before it got its Everyone tab, hence the name) counts as a
// "channel" of its own here: it's highlighted in the sidebar and is a step for the back button like
// any channel. (The server never hears this name.)
const FRIENDS = "friends";
const LOUNGE = "voice:lounge";  // the Lounge page (a "channel" name like FRIENDS, so switching works the same)
let myId = null;            // our own user id; the server tells us in its "welcome"
let season = null;          // the server's season now: {name, emoji, video} or null (the easter egg, people.js)
let myPresence = "online";  // the status we chose: online, idle, dnd or invisible ("welcome", "my_presence")
// The server's limits (server.py, LIMITS), from "welcome": limits.custom_emoji, limits.upload_size, ...
// Empty until then, which is fine: nothing that reads them can be used before we're connected.
let limits = {};

// Text boxes whose maxlength is one of those limits: the box's id -> the limit's name. The browser
// then refuses typing past it by itself (the server checks again).
const LIMITED_INPUTS = {
  "status-input": "status",
  "bio-input": "bio",
  "emoji-name": "emoji_name",
  "group-name": "channel_name",
  "new-channel-name": "channel_name",
  "new-role-name": "role_name",
  "ban-reason": "ban_reason",
  "feedback-text": "feedback",
};

// A size limit in words: 52428800 -> "50 MB".
function megabytes(bytes) {
  return Math.round(bytes / (1024 * 1024)) + " MB";
}

function applyLimits() {
  for (const [id, name] of Object.entries(LIMITED_INPUTS)) {
    document.getElementById(id).maxLength = limits[name];
  }
}
let pendingJump = null;     // a message id to go to once its channel's history arrives (from a notification)
let jumpTarget = null;      // the message we last jumped to: pictures loading keep it in view (messages.js)
let loadingOlder = false;   // asked the server for older messages, and waiting for them (messages.js)
let reachedStart = false;   // the channel's very first message is on the page: nothing older to load
let reconnectDelay = 1000;  // milliseconds to wait before the next reconnect attempt
const unread = new Set();   // channels and DMs with messages we haven't seen
const mentionCounts = new Map();  // channel -> how many unread messages there mention us
const mutedChats = new Set();  // chats we muted (the server's "mutes"): no unread dot, greyed out
const pinnedChats = new Set();  // DMs and groups we pinned to the top of the list (the server's "pinned_chats")
// Each DM's and group's newest message id ("chat_activity"): the DM list is sorted by it, newest first.
const chatActivity = new Map();
let friendsKnown = false;      // has the first "friends" list arrived? (after it, new requests notify)

// ----- Reloading by itself after an update to the page (like pressing F5)
//
// The server sends a fingerprint of the page's files (its "page_version") in every welcome.
// When a reconnect brings a different one, this page is running old code: reload, so everyone
// gets fixes without being told to press F5. But not while something would be lost by it: a
// call (it would drop), files waiting to be sent, a message being sent or edited. Until then,
// try again every few seconds. What's typed survives, in every chat: saved in sessionStorage (kept
// by the browser for this tab through a reload) and put back by restoreDraft.
let pageVersion = null;  // the version this page was loaded with
let outdated = false;    // true once the server has a newer one

function reloadIfOutdated() {
  if (!outdated || voiceRoomName || anythingInTrays() || sending || editingId !== null) return;
  try {
    // Every chat's text (messages.js, drafts), the open one's from the text box, as JSON text.
    sessionStorage.setItem("drafts", JSON.stringify({ ...drafts, [currentChannel]: input.value }));
  } catch {}
  location.reload();
}
setInterval(reloadIfOutdated, 5000);

// After a reload: put back what was typed in each chat (the first chat that opens shows its own).
function restoreDraft() {
  try {
    Object.assign(drafts, JSON.parse(sessionStorage.getItem("drafts") ?? "{}"));
    sessionStorage.removeItem("drafts");
    // A page from before chats had their own text saved just the text box's, as "draft".
    const old = sessionStorage.getItem("draft");
    sessionStorage.removeItem("draft");
    if (old) input.value = old;
  } catch {}
}

// Ask the server which channels exist, show them in the sidebar, then connect.
async function start() {
  restoreDraft();
  const response = await fetch("/channels");  // (only the ones we may see)
  showChannels(response.ok ? await response.json() : []);  // (not logged in: the WebSocket sends us to the login page)
  connect();
  ensureEmojiData();  // in the background (no await): the autocomplete needs the emoji names
}

// Is this the key of a channel that exists? (Not a heading, a DM, Friends or the Lounge.)
function isChannel(key) {
  return channels.some((item) => item.key === key && !item.heading);
}

// A channel's name, from its key (the key itself if it's gone).
function channelName(key) {
  return channels.find((item) => item.key === key)?.name ?? key;
}

// (Re)draw the sidebar's channels: at the start, and whenever an admin changes them (a "channels"
// message, to every page). A heading is a small title over the channels below it.
function showChannels(list) {
  channels = list;
  // (No channel at all, which can happen to someone with a limited role: the People page.)
  firstChannel = channels.find((item) => !item.heading)?.key ?? FRIENDS;
  channelList.replaceChildren();  // the old buttons and headings out
  for (const item of channels) {
    if (item.heading) {
      const heading = document.createElement("h2");
      heading.className = "section-heading";
      heading.textContent = item.name;  // textContent: an admin typed it, so never as HTML
      channelList.appendChild(heading);
      continue;
    }
    const button = document.createElement("button");
    button.className = "channel";
    button.textContent = "# " + item.name;
    button.dataset.channel = item.key;  // remember which channel this button is for
    button.addEventListener("click", () => switchChannel(item.key, channelLabel(item.key)));
    channelList.appendChild(button);
  }
  updateSidebar();  // new buttons: mark where we are and what's unread again
}

// The server's "channels": an admin changed them (or we just connected). Only the channels we may
// see (a private one needs one of its roles), and `lounge`: false for someone with a limited role,
// who has no Lounge (server.py, "Who sees which channel").
function channelsChanged(list, lounge) {
  showChannels(list);
  loungeAllowed = lounge !== false;
  voiceHeading.hidden = voiceList.hidden = !loungeAllowed;
  renderChannelAdmin();  // Settings → Channels, in case an admin has it open (settings.js)
  renderMembers();       // (who sees this channel may have changed; people.js)
  if (currentChannel === null) return;  // not started yet: connect's "open" picks one
  const special = currentChannel === FRIENDS || (currentChannel === LOUNGE && loungeAllowed)
    || currentChannel.startsWith("dm:") || isGroup(currentChannel);
  if (!special && !isChannel(currentChannel)) {
    switchChannel(firstChannel, channelLabel(firstChannel));  // ours was deleted (or we may not see it any more)
  } else {
    setLabel(channelLabel(currentChannel));  // (it may have been renamed)
  }
}

// Open the WebSocket. Called once at the start, and again each time the connection drops.
function connect() {
  // On the real site the page comes over HTTPS, so the WebSocket must be encrypted too:
  // wss:// instead of ws:// (like https:// instead of http://).
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  // We can only send once the connection is open, so join a channel then.
  socket.addEventListener("open", () => {
    reconnectDelay = 1000;  // it worked, so start from 1 second again next time
    banner.hidden = true;
    sendVoiceState();  // a new connection: the server doesn't know we're in voice yet
    sendLooking();     // ...nor whether we're looking at the chat (no pushes then; notifications.js)
    sendActivity();    // ...nor what we're doing (the Windows app; settings.js, "Activity")
    const opened = new URLSearchParams(location.search);  // "?channel=general&message=57"
    if (currentChannel === null && opened.has("channel")) {
      // Opened by tapping a push notification (sw.js): go to that message (or that DM, for a call).
      // Then take the question mark part out of the address, so a reload doesn't go there again.
      history.replaceState(null, "", "/");
      openMessage(opened.get("channel"), opened.has("message") ? Number(opened.get("message")) : null);
    } else if (currentChannel === null) {
      // First time: the channel we were in before a reload (F5), else the chat open when this browser
      // (or the Windows app) was last closed, else the first channel.
      const start = channelBeforeReload() ?? lastChat() ?? firstChannel;
      switchChannel(start, channelLabel(start));
    } else {
      joinCurrentChannel();  // reconnected: rejoin where we were, which reloads the history
      checkForAppUpdate();   // the server restarted, perhaps for a new version of the app
    }
  });

  socket.addEventListener("message", handleServerMessage);

  socket.addEventListener("close", (event) => {
    if (event.code === 4001) {
      location.href = "/login";  // the server says we're not logged in
      return;
    }
    // Try again later, waiting twice as long each time (max 10 seconds): exponential backoff.
    banner.hidden = false;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  });
}

// In the desktop app: ask it to look for a new version of itself (main.rs, check_for_update). If
// there is one, the app swaps the chat for its update window, installs it and starts again. Not
// during a call, which that would drop: leaveVoice asks again afterwards. (inDesktopApp is from
// notifications.js. Apps older than 0.1.13 don't know the command: their "no" is ignored.)
function checkForAppUpdate() {
  if (!inDesktopApp || voiceRoomName) return;
  window.__TAURI_INTERNALS__.invoke("check_for_update").catch(() => {});
}

// The channel this tab was in before a reload, or null. switchChannel saves every channel in the
// browser's history for the back button ({channel: "memes"}), and the browser keeps that through
// a reload. Only something that still exists counts: a channel the server lists, Friends, Lounge,
// a DM or a group (one we're no longer in is left again once the friend or group list arrives).
function channelBeforeReload() {
  return stillThere(history.state?.channel);
}

// The chat that was open when this browser or the Windows app was last closed (switchChannel saves it
// in localStorage, which stays on this device, each its own; the user's wish), or null.
function lastChat() {
  try {
    return stillThere(localStorage.getItem("lastChat"));
  } catch {
    return null;  // (storage blocked: start in the first channel)
  }
}

// The chat itself, if it can still be opened, else null: a channel the server lists (it lists only those
// we may see), People, the Lounge, a DM or a group. (A DM or group we're no longer in, or the Lounge for
// someone limited, is left again once the server's lists arrive.)
function stillThere(channel) {
  if (typeof channel !== "string") return null;
  if (isChannel(channel) || channel === FRIENDS || channel === LOUNGE || channel.startsWith("dm:") || isGroup(channel)) {
    return channel;
  }
  return null;
}

// Send something to the server, but only if we're connected. Returns true if it was sent.
// (A closed WebSocket silently throws away what you send, and a connecting one throws an error.)
// The Windows app keeps this window hidden behind its loading window until we're worth looking at
// (main.rs, "The loading window"): connected, and the first chat drawn. Saying it again after a
// reload does nothing; an app from before 0.1.21 doesn't know the command (it showed us at once).
function tellAppReady() {
  if (inDesktopApp) window.__TAURI_INTERNALS__.invoke("page_ready").catch(() => {});
  hidePageLoading();
}

// The loading cover (index.html, #page-loading): fades out once the chat is filled in (above), and after
// 10 seconds at the latest, so a server that's down shows its "reconnecting" banner instead.
const pageLoading = document.getElementById("page-loading");

function hidePageLoading() {
  if (pageLoading.classList.contains("done")) return;
  pageLoading.classList.add("done");  // (chat.css: fades out in 0.25 s)
  setTimeout(() => pageLoading.remove(), 300);
}

setTimeout(hidePageLoading, 10000);

function sendToServer(data) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(data));  // object -> JSON string
  return true;
}

// Everything the server sends comes through here. Its "type" says what it is.
function handleServerMessage(event) {
  const data = JSON.parse(event.data);  // JSON string -> object

  if (data.type === "welcome") {
    myId = data.id;
    myPresence = data.presence || "online";
    maxTextLength = data.max_text_length;
    input.maxLength = maxTextLength;  // the textarea's maxlength, from the server's limit
    limits = data.limits;
    applyLimits();
    applyAppearance(data.appearance || {});  // the account's (appearance.js); null: the defaults
    vapidPublicKey = data.vapid_public_key;  // for push notifications (notifications.js)
    season = data.season;  // the seasonal easter egg, or null (people.js, renderUserPanel)
    showPhoneBanner();  // now that we know whether the server has push (notifications.js)
    offerAndroidApp();  // on an Android phone: the real app (notifications.js)
    if (pageVersion === null) {
      pageVersion = data.page_version;  // the first welcome: the version we were loaded with
    } else if (data.page_version !== pageVersion) {
      outdated = true;  // a reconnect after a deploy that changed the page
      reloadIfOutdated();
    }
    return;
  }
  if (data.type === "channels") {
    channelsChanged(data.channels, data.lounge);
    return;
  }
  if (data.type === "blocks") {
    // The people we blocked (at the start, and after blocking or unblocking here or elsewhere).
    setAll(blockedIds, data.blocked);
    friendsChanged();  // (the Friends page's Blocked tab, and a profile that's open)
    if (shownMessages.length) redrawMessages();  // their messages hidden, or shown again
    return;
  }
  if (data.type === "pinned_chats") {
    // Our pinned DMs and groups (at the start, and after pinning or unpinning here or on another device).
    setAll(pinnedChats, data.channels);
    renderDmList();  // (people.js)
    if (currentChannel !== null) showGroupHeader();  // (a group's Pin / Unpin button)
    return;
  }
  if (data.type === "chat_activity") {
    // The newest message in our DMs and groups: all of them at the start, then one after each new message.
    // The list only needs drawing again when that changes its order.
    const before = sortedDmKeys().join();
    for (const [key, id] of Object.entries(data.chats)) chatActivity.set(key, Math.max(id, chatActivity.get(key) ?? 0));
    if (sortedDmKeys().join() !== before) renderDmList();
    return;
  }
  if (data.type === "mutes") {
    // Our muted chats (at the start, and after muting or unmuting here or on another device).
    setAll(mutedChats, data.channels);
    updateSidebar();
    if (currentChannel !== null) showDmHeader();  // (the 🔔 / 🔕 button)
    return;
  }
  if (data.type === "my_presence") {
    myPresence = data.presence;  // chosen here or on another device (people.js, the status picker)
    renderUserPanel();
    return;
  }
  if (data.type === "search_results") {
    showSearchResults(data);  // (messages.js; from every chat, so not filtered by channel below)
    return;
  }
  if (data.type === "groups") {
    setGroups(data.groups);  // our group DMs (people.js)
    return;
  }
  if (data.type === "appearance") {
    applyAppearance(data.appearance);  // changed in Settings, here or on another device
    return;
  }
  if (data.type === "renamed") {
    // Someone changed their username. The DM list already updated (from the "users"
    // message); reload the messages on screen so old messages show the new name too.
    if (data.id !== myId && currentChannel === dmChannel(data.id)) {
      setLabel("@" + data.username);  // we're in a DM with them
    }
    if (currentChannel !== null) joinCurrentChannel();
    return;
  }
  if (data.type === "custom_emoji") {
    setCustomEmoji(data.emoji);
    return;
  }
  if (data.type === "friends") {
    // Our own friends and requests (only we get this): {friends: [ids], incoming, outgoing}
    const before = new Set(incomingIds);
    setAll(friendIds, data.friends);
    setAll(incomingIds, data.incoming);
    setAll(outgoingIds, data.outgoing);
    friendsChanged();
    // A request that's new since the last list: notify. (Not the ones already waiting when the page
    // loaded: the first list only fills friendsKnown.)
    if (friendsKnown) {
      for (const id of incomingIds) if (!before.has(id)) notifyFriendRequest(id);  // (notifications.js)
    }
    friendsKnown = true;
    return;
  }
  if (data.type === "roles") {
    // The roles changed (an admin, in Settings → Roles): names, the member list, open profile, Settings.
    roles = data.roles;
    showUsers([...people.values()]);  // (people.js: the same people, drawn again with the new roles)
    redrawMessages();                 // (names above messages take their colour from roles)
    renderRoleAdmin();                // (settings.js)
    renderChannelAdmin();             // (its private channels list the roles)
    return;
  }
  if (data.type === "users") {
    // Who has which role, as text: if that changed, the names above messages need their new colour.
    const rolesBefore = JSON.stringify([...people.values()].map((person) => [person.id, person.roles]));
    showUsers(data.users);
    if (currentChannel === FRIENDS || currentChannel === LOUNGE) tellAppReady();  // (no messages to wait for there)
    if (JSON.stringify(data.users.map((user) => [user.id, user.roles])) !== rolesBefore) {
      redrawMessages();
      renderRoleAdmin();
    }
    renderVoiceMembers();  // (names may have changed)
    // A DM's name ("@kari") needs the people: after a reload straight into a DM, they only
    // arrive now, so the label said "@someone" until this.
    if (currentChannel !== null) setLabel(channelLabel(currentChannel));
    return;
  }
  if (data.type === "call" || data.type === "call_answered" || data.type === "call_ended") {
    handleCallMessage(data);
    renderCallPanel();  // ("Calling…" under their picture comes and goes with these)
    return;
  }
  if (data.type === "dm_call") {
    // Who's in one of our DMs' calls (for the banner and "Join call").
    dmCalls[data.channel] = data.members;
    renderCallPanel();
    return;
  }
  if (data.type === "voice_members") {
    voiceMembers = data.rooms;
    renderVoiceMembers();
    return;
  }
  if (data.type === "unread") {
    for (const channel of data.channels) {
      if (channel !== currentChannel) unread.add(channel);  // where we are is never unread
    }
    // Unread mentions, like {"memes": 2}. Object.entries turns it into [["memes", 2], ...].
    for (const [channel, count] of Object.entries(data.mentions || {})) {
      if (channel === currentChannel || count === 0) mentionCounts.delete(channel);
      else mentionCounts.set(channel, count);
    }
    updateSidebar();
    // A DM or mention in another channel: notify (we're not looking at that channel anyway).
    if (data.notify) {
      notify(data.notify.channel, data.notify.id, data.notify.user_id, data.notify.name, data.notify.text);
    }
    return;
  }

  // Everything else belongs to a channel. Ignore it if it's for a channel we
  // just left (it was already on its way when we switched).
  if (data.channel !== currentChannel) return;

  if (data.type === "history") {
    shownMessages = data.messages;  // remembered, so we can redraw after edits and deletes
    reachedStart = !data.more;      // not a full batch: this is the whole channel
    // Where we stopped reading (messages.js, "New messages" divider). Only if something newer
    // is here: otherwise the next message to arrive would get the line. (Never opened: none.)
    const newest = shownMessages.at(-1)?.id ?? 0;
    newMessagesAfter = data.last_read !== null && newest > data.last_read ? data.last_read : null;
    if (reachedStart) messages.appendChild(makeChannelStart());
    for (const message of shownMessages) {
      showMessage(message);
    }
    scrollToNewDivider();  // lots of new ones: start at the line, not the bottom
    // Opened from a notification: now that its message is on the page, go to it.
    if (pendingJump !== null) {
      jumpToMessage(pendingJump);
      pendingJump = null;
    }
    tellAppReady();  // the chat is filled in: the app may show us now
  } else if (data.type === "older") {
    // The batch we asked for by scrolling up. If we didn't ask (or switched channels and back
    // since, which resets loadingOlder), it no longer fits what's on the page: ignore it.
    if (!loadingOlder) return;
    showOlderMessages(data.messages, data.more);
  } else if (data.type === "message") {
    stopTyping(data.name);  // their message arrived, so they're done typing
    shownMessages.push(data);
    if (data.user_id === myId) {
      removeNewDivider();  // we wrote something (here or on another device): caught up
    } else if (!isLooking() && !newWhileAway) {
      // The first message while we're away (tab hidden, window not focused): the line moves
      // above it, so coming back shows where we left off. (ids only grow, so "after id - 1"
      // is this message and everything after it.)
      removeNewDivider();
      newMessagesAfter = data.id - 1;
      newWhileAway = true;
    }
    showMessage(data);
    // In the channel we're in, but the tab is hidden or the window isn't focused:
    // a DM or a mention still notifies, and counts in the tab title until we're back.
    // In a muted chat only when we're named in it, or an admin wrote it (like the server's save_mentions).
    const forMe = data.user_id !== myId && !blockedIds.has(data.user_id) && (mutedChats.has(currentChannel)
      ? data.text.includes(`<@${myId}>`) || people.get(data.user_id)?.admin === true
      : dmPartner(currentChannel) !== null || isGroup(currentChannel) || mentionsMe(data.text));
    if (forMe && !isLooking()) {
      missedWhileAway += 1;
      updateTitle();
      notify(data.channel, data.id, data.user_id, data.name, data.text || (data.file ? "📎 Attachment" : ""));
    }
  } else if (data.type === "preview") {
    // A link's preview arrived (a moment after its message): add it, and redraw.
    const message = shownMessages.find((m) => m.id === data.message_id);
    if (message) {
      message.preview = data.preview;
      redrawMessages();
    }
  } else if (data.type === "edited") {
    // A message was edited: update it in our list (and quotes of it in replies), then redraw.
    const edited = shownMessages.find((message) => message.id === data.message_id);
    if (edited) {
      edited.text = data.text;
      edited.edited_at = data.edited_at;
    }
    for (const message of shownMessages) {
      if (message.reply && message.reply.id === data.message_id && !message.reply.deleted) {
        message.reply.text = data.text.slice(0, 100).replace(/<:\d*$/, "");  // like the server's quote
      }
    }
    redrawMessages();
  } else if (data.type === "deleted") {
    // A message was deleted: take it out of our list, mark replies to it, and redraw.
    shownMessages = shownMessages.filter((message) => message.id !== data.message_id);
    for (const message of shownMessages) {
      if (message.reply && message.reply.id === data.message_id) {
        message.reply = { id: data.message_id, deleted: true };
      }
    }
    if (editingId === data.message_id) editingId = null;
    redrawMessages();
    if (pinsDialog.open) sendToServer({ type: "pins" });  // (it may have been pinned)
  } else if (data.type === "pinned") {
    // A message was pinned or unpinned (by anyone): its 📌 button, and the list if it's open.
    const message = shownMessages.find((m) => m.id === data.message_id);
    if (message) {
      message.pinned = data.pinned;
      redrawMessages();
    }
    if (pinsDialog.open) sendToServer({ type: "pins" });
  } else if (data.type === "pins") {
    showPins(data.messages);  // the 📌 list (messages.js)
  } else if (data.type === "pins_full") {
    showUploadError(`This chat already has ${data.max} pinned messages: unpin one first.`);
  } else if (data.type === "typing") {
    showTyping(data.name);
  } else if (data.type === "reactions") {
    // A message's reactions changed: remember them (for redraws), and redraw just its chip row.
    const reacted = shownMessages.find((message) => message.id === data.message_id);
    if (reacted) reacted.reactions = data.reactions;
    const row = messages.querySelector(`[data-id="${data.message_id}"] .reactions`);
    if (row) {
      const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
      renderReactions(row, data.message_id, data.reactions);
      // A new chip row makes the message taller: stay at the bottom if we were there.
      if (distanceFromBottom < 50) messages.scrollTop = messages.scrollHeight;
    }
  }
}

// Show where we are: in the text box's placeholder, and in the phone top bar.
function setLabel(label) {
  input.placeholder = "Message " + label;
  topbarTitle.textContent = label;
  showDmHeader();  // the call bar, in DMs
}

// Switch channel or DM. `label` is what to show in the text box, like "#general" or "@kari".
// `fromHistory` is true when the back (or forward) button brought us here: then the history
// already has this step, and adding it again would make back bounce between two channels.
function switchChannel(channel, label, fromHistory = false) {
  closeDrawers();  // on a phone: picking a channel closes the drawer
  if (channel === currentChannel) return;
  if (!fromHistory) {
    // A new step for the back button (see "The back button" below). The very first channel,
    // or one picked while a drawer or popup was open, takes the place of the current step.
    if (currentChannel === null || history.state?.overlay) {
      history.replaceState({ channel }, "");
    } else {
      history.pushState({ channel }, "");
    }
  }
  switchDraft(currentChannel, channel);  // each chat keeps its own text and tray (messages.js)
  currentChannel = channel;
  try {
    localStorage.setItem("lastChat", channel);  // to open it again next time (lastChat)
  } catch {}
  setLabel(label);
  unread.delete(channel);  // opening it means we've seen it
  mentionCounts.delete(channel);
  updateSidebar();
  joinCurrentChannel();
  clearSeenNotifications();  // ...and its push notifications on this phone (notifications.js)
}

// Clear the screen and tell the server where we are. It answers with the history.
// (If we're disconnected right now, nothing is sent; we rejoin when we reconnect.)
function joinCurrentChannel() {
  messages.replaceChildren();  // remove all the old messages
  shownMessages = [];
  editingId = null;
  lastShown = null;            // so the first message starts a fresh group (and date divider)
  newMessagesAfter = null;     // (messages.js: the history brings where we stopped reading)
  newDividerDrawn = false;
  newWhileAway = false;
  jumpTarget = null;           // a fresh channel starts at the bottom
  loadingOlder = false;        // an answer still on its way belongs to what we just cleared
  reachedStart = false;        // (the history says whether there's more)
  pendingJump = null;          // (openMessage sets it again right after switching)
  jumpLoading = null;          // (messages.js: loading older messages to reach one, in the old channel)
  clearReply();                // a reply belongs to the channel we just left
  clearTyping();
  // Show the People page (FRIENDS), the Lounge page or the channel: one of them.
  const inFriends = currentChannel === FRIENDS;
  const inLounge = currentChannel === LOUNGE;
  friendsView.hidden = !inFriends;
  loungeView.hidden = !inLounge;
  channelView.hidden = inFriends || inLounge;
  // The text box can only measure its text now that it's shown (ui.js, autoGrow): from the Lounge or
  // the People page, switchDraft's autoGrow ran while it was still hidden.
  if (!channelView.hidden) autoGrow();
  renderMembers();  // the right column shows who's in this chat (people.js)
  if (inLounge) {
    renderLoungeView();
    sendToServer({ type: "join", channel: null });  // no text channel here either
  } else if (inFriends) {
    peopleStatus.textContent = "";
    renderPeopleList();
    // null = "not looking at any channel", so new messages everywhere get their unread dots.
    sendToServer({ type: "join", channel: null });
  } else {
    sendToServer({ type: "join", channel: currentChannel });
  }
}

// The DM channel name for us and another person: both user ids, smallest first,
// so both people end up with the same name. Users 7 and 3, either way round -> "dm:3:7".
// Ids, not usernames: a username can change, an id never does.
function dmChannel(otherId) {
  // sort() on its own compares as *text*, so [10, 9] would stay [10, 9] ("1" comes before "9").
  // (a, b) => a - b makes it compare as numbers: negative means a goes first.
  const ids = [myId, otherId].sort((a, b) => a - b);
  return "dm:" + ids.join(":");
}

// Mark the sidebar buttons (channels and DMs): highlight where we are, and dot the unread ones.
function updateSidebar() {
  // querySelectorAll finds every element matching a CSS selector:
  // here, everything with a data-channel attribute (all channel and DM buttons).
  for (const button of document.querySelectorAll("[data-channel]")) {
    button.classList.toggle("active", button.dataset.channel === currentChannel);
    // A muted chat: greyed out, and no unread dot (a red count still shows, for a mention by name).
    const muted = mutedChats.has(button.dataset.channel);
    button.classList.toggle("muted", muted);
    button.classList.toggle("unread", unread.has(button.dataset.channel) && !muted);
    // A red number for unread mentions there (stronger than the white dot).
    button.querySelector(".mention-badge")?.remove();
    const count = mentionCounts.get(button.dataset.channel);
    if (count) {
      const badge = document.createElement("span");
      badge.className = "mention-badge";
      badge.textContent = count;
      button.appendChild(badge);
    }
  }
  // Phones: a dot on ☰ if anything is unread, since the sidebar is hidden there.
  openSidebarButton.classList.toggle(
    "has-unread", [...unread].some((channel) => !mutedChats.has(channel)) || mentionCounts.size > 0 || incomingIds.size > 0
  );
  updateTitle();  // "(3) ChatApp"
}
