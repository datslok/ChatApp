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
let channelNames = [];      // every channel, from the server: ["general", "memes"]
// The Friends page counts as a "channel" of its own here: it's highlighted in the sidebar
// and is a step for the back button like any channel. (The server never hears this name.)
const FRIENDS = "friends";
const LOUNGE = "voice:lounge";  // the Lounge page (a "channel" name like FRIENDS, so switching works the same)
let myId = null;            // our own user id; the server tells us in its "welcome"
let pendingJump = null;     // a message id to go to once its channel's history arrives (from a notification)
let jumpTarget = null;      // the message we last jumped to: pictures loading keep it in view (messages.js)
let reconnectDelay = 1000;  // milliseconds to wait before the next reconnect attempt
const unread = new Set();   // channels and DMs with messages we haven't seen
const mentionCounts = new Map();  // channel -> how many unread messages there mention us

// Ask the server which channels exist, make a sidebar button for each, then connect.
async function start() {
  const response = await fetch("/channels");
  const channels = await response.json();  // e.g. ["general", "memes"]

  for (const channel of channels) {
    const button = document.createElement("button");
    button.className = "channel";
    button.textContent = "# " + channel;
    button.dataset.channel = channel;  // remember which channel this button is for
    button.addEventListener("click", () => switchChannel(channel, "#" + channel));
    channelList.appendChild(button);
  }

  firstChannel = channels[0];
  channelNames = channels;
  connect();
  ensureEmojiData();  // in the background (no await): the autocomplete needs the emoji names
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
    if (currentChannel === null) {
      // First time: the channel we were in before a reload (F5), else the first channel.
      const start = channelBeforeReload() ?? firstChannel;
      switchChannel(start, channelLabel(start));
    } else {
      joinCurrentChannel();  // reconnected: rejoin where we were, which reloads the history
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

// The channel this tab was in before a reload, or null. switchChannel saves every channel in the
// browser's history for the back button ({channel: "memes"}), and the browser keeps that through
// a reload. Only something that still exists counts: a channel the server lists, Friends, Lounge,
// or a DM (one with someone who's no longer a friend is left again once the friend list arrives).
function channelBeforeReload() {
  const channel = history.state?.channel;
  if (typeof channel !== "string") return null;
  if (channelNames.includes(channel) || channel === FRIENDS || channel === LOUNGE || channel.startsWith("dm:")) {
    return channel;
  }
  return null;
}

// Send something to the server, but only if we're connected. Returns true if it was sent.
// (A closed WebSocket silently throws away what you send, and a connecting one throws an error.)
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
    maxTextLength = data.max_text_length;
    input.maxLength = maxTextLength;  // the textarea's maxlength, from the server's limit
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
    setAll(friendIds, data.friends);
    setAll(incomingIds, data.incoming);
    setAll(outgoingIds, data.outgoing);
    friendsChanged();
    return;
  }
  if (data.type === "users") {
    showUsers(data.users);
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
    for (const message of shownMessages) {
      showMessage(message);
    }
    // Opened from a notification: now that its message is on the page, go to it.
    if (pendingJump !== null) {
      jumpToMessage(pendingJump);
      pendingJump = null;
    }
  } else if (data.type === "message") {
    stopTyping(data.name);  // their message arrived, so they're done typing
    shownMessages.push(data);
    showMessage(data);
    // In the channel we're in, but the tab is hidden or the window isn't focused:
    // a DM or a mention still notifies, and counts in the tab title until we're back.
    const forMe = data.user_id !== myId && (dmPartner(currentChannel) !== null || mentionsMe(data.text));
    if (forMe && !isLooking()) {
      missedWhileAway += 1;
      updateTitle();
      notify(data.channel, data.id, data.user_id, data.name, data.text || (data.file ? "📎 Attachment" : ""));
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
  currentChannel = channel;
  setLabel(label);
  unread.delete(channel);  // opening it means we've seen it
  mentionCounts.delete(channel);
  updateSidebar();
  joinCurrentChannel();
}

// Clear the screen and tell the server where we are. It answers with the history.
// (If we're disconnected right now, nothing is sent; we rejoin when we reconnect.)
function joinCurrentChannel() {
  messages.replaceChildren();  // remove all the old messages
  shownMessages = [];
  editingId = null;
  lastShown = null;            // so the first message starts a fresh group (and date divider)
  jumpTarget = null;           // a fresh channel starts at the bottom
  pendingJump = null;          // (openMessage sets it again right after switching)
  clearReply();                // a reply belongs to the channel we just left
  clearTyping();
  // Show the Friends page, the Lounge page or the channel: one of them.
  const inFriends = currentChannel === FRIENDS;
  const inLounge = currentChannel === LOUNGE;
  friendsView.hidden = !inFriends;
  loungeView.hidden = !inLounge;
  channelView.hidden = inFriends || inLounge;
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
    button.classList.toggle("unread", unread.has(button.dataset.channel));
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
    "has-unread", unread.size > 0 || mentionCounts.size > 0 || incomingIds.size > 0
  );
  updateTitle();  // "(3) ChatApp"
}
