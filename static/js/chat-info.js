// The chat info panel: a DM's or group's name in the top bar opens it in the right column, like
// Discord's. Five tabs: Members (the member list that's already there, people.js renderMembers),
// Media (pictures and videos as a grid), Pins (the pinned messages, as in the 📌 popup), Links and
// Files. The last three come from the server ({"type": "chat_info"}, server.py "Chat info"), 50
// messages at a time, newest first: scrolling to the bottom asks for the next 50.
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use. This one
// comes before messages.js, whose functions (makePinnedItem, makeFileLink, ...) it only calls
// later, when something is clicked or arrives.

const chatInfoTop = document.getElementById("chat-info-top");
const chatInfoTabButtons = document.querySelectorAll(".chat-info-tab");
const memberLists = document.getElementById("member-lists");
const chatInfoList = document.getElementById("chat-info-list");
const chatInfoStatus = document.getElementById("chat-info-status");
const viewerVideo = document.getElementById("viewer-video");
const viewerJump = document.getElementById("viewer-jump");

let chatInfoTab = null;      // the open tab ("members", "media", "pins", "links" or "files"); null: closed
let chatInfoItems = [];      // the messages shown in a list tab, newest first
let chatInfoOldest = null;   // where the next batch starts (the server's "oldest")
let chatInfoMore = false;    // the server may have more
let chatInfoLoading = false; // a batch is on its way: don't ask twice

// The phone layout (chat.css, @media (max-width: 700px)): the right column is a drawer there.
// matchMedia asks the browser whether a media query is true right now.
function onPhoneLayout() {
  return matchMedia("(max-width: 700px)").matches;
}

function openChatInfo(tab = "members") {
  membersElement.classList.add("info-open");  // (wider, and shown even if 👥 had hidden the list: chat.css)
  chatInfoTop.hidden = false;
  showChatInfoTab(tab);
  if (onPhoneLayout()) openDrawer(membersElement);
}

// Back to the plain member list (or to no column, if 👥 had hidden it).
function closeChatInfo() {
  if (chatInfoTab === null) return;
  chatInfoTab = null;
  membersElement.classList.remove("info-open");
  chatInfoTop.hidden = true;
  memberLists.hidden = false;
  chatInfoList.hidden = chatInfoStatus.hidden = true;
  chatInfoList.replaceChildren();
}

function showChatInfoTab(tab) {
  chatInfoTab = tab;
  for (const button of chatInfoTabButtons) {
    button.setAttribute("aria-pressed", button.dataset.tab === tab ? "true" : "false");
  }
  memberLists.hidden = tab !== "members";
  chatInfoList.hidden = tab === "members";
  chatInfoStatus.hidden = true;
  if (tab !== "members") loadChatInfo();
}

// Ask for a list tab from the start (also when something in it changed: see chatInfoNews).
function loadChatInfo() {
  chatInfoItems = [];
  chatInfoOldest = null;
  chatInfoMore = false;
  chatInfoLoading = true;
  chatInfoList.replaceChildren();
  // Each tab its own look (chat.css): a grid of squares, the pinned cards, or rows.
  chatInfoList.className = chatInfoTab === "media" ? "media-grid" : chatInfoTab === "pins" ? "card-list" : "info-rows";
  chatInfoStatus.hidden = false;
  chatInfoStatus.textContent = "Loading…";
  if (chatInfoTab === "pins") sendToServer({ type: "pins" });  // (the answer: showChatInfoPins)
  else sendToServer({ type: "chat_info", tab: chatInfoTab, before: null });  // (the answer: showChatInfo)
}

// The next batch, once the list is scrolled near its end (the column itself scrolls: #members).
function loadMoreChatInfo() {
  if (chatInfoLoading || !chatInfoMore || chatInfoList.hidden) return;
  chatInfoLoading = true;
  sendToServer({ type: "chat_info", tab: chatInfoTab, before: chatInfoOldest });
}
membersElement.addEventListener("scroll", () => {
  const left = membersElement.scrollHeight - membersElement.scrollTop - membersElement.clientHeight;
  if (left < 300) loadMoreChatInfo();
});

// A batch from the server (core.js, "chat_info"). One for another tab, or for a question we no longer
// ask (the tab was switched or reloaded meanwhile), is left out.
function showChatInfo(data) {
  if (data.tab !== chatInfoTab || data.before !== chatInfoOldest) return;
  // A first batch replaces what's there (reloaded twice quickly: both answers have before null).
  if (data.before === null) {
    chatInfoItems = [];
    chatInfoList.replaceChildren();
  }
  // Not from people we blocked (their messages are hidden in the chat too, behind Show).
  const items = data.items.filter((message) => !blockedIds.has(message.user_id));
  chatInfoItems.push(...items);
  chatInfoOldest = data.oldest;
  chatInfoMore = data.more;
  chatInfoLoading = false;
  for (const message of items) chatInfoList.append(...makeChatInfoItems(message));
  showChatInfoEmpty();
  // Too few to scroll (a short batch after blocked ones were left out): no scroll event would ever come.
  if (membersElement.scrollHeight <= membersElement.clientHeight + 300) loadMoreChatInfo();
}

// The Pins tab: the server's answer to "pins" (core.js; the 📌 popup gets the same answer).
function showChatInfoPins(list) {
  if (chatInfoTab !== "pins") return;
  chatInfoItems = list;
  chatInfoLoading = false;
  chatInfoList.replaceChildren(...list.map(makePinnedItem));  // (messages.js: the card with Jump and Unpin)
  // Its Jump (the first button) on a phone: the drawer goes too, or it would cover the message.
  for (const jump of chatInfoList.querySelectorAll(".card-buttons button:first-child")) {
    jump.addEventListener("click", () => {
      if (onPhoneLayout()) closeDrawers();
    });
  }
  showChatInfoEmpty();
}

function showChatInfoEmpty() {
  const empty = {
    media: "No pictures or videos here yet.",
    pins: "Nothing pinned here yet. Hover over a message and click the pin to pin it.",
    links: "No links here yet.",
    files: "No files here yet.",
  };
  chatInfoStatus.hidden = chatInfoItems.length > 0;
  chatInfoStatus.textContent = empty[chatInfoTab];
}

// What one message adds to the open tab: a square, or a row per link, or a file's row.
function makeChatInfoItems(message) {
  if (chatInfoTab === "media") return [makeMediaTile(message)];
  if (chatInfoTab === "links") return message.links.map((url, index) => makeLinkRow(message, url, index));
  return [makeFileRow(message)];
}

// A picture or a video's first frame, cut to a square (object-fit: cover in chat.css), as a button.
function makeMediaTile(message) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "media-tile";
  tile.title = message.file.filename;
  const url = "/uploads/" + encodeURIComponent(message.file.id);
  if (message.file.video) {
    const video = document.createElement("video");
    video.src = url;
    video.preload = "metadata";  // only its first frame and length, not the whole video
    video.muted = true;
    tile.append(video, makeIcon("play"));
  } else {
    const picture = document.createElement("img");
    picture.src = url;
    picture.alt = message.file.filename;
    picture.loading = "lazy";  // only loaded when scrolled near: a long grid doesn't fetch everything at once
    tile.appendChild(picture);
  }
  tile.addEventListener("click", () => openMedia(message));
  return tile;
}

// One link: the preview card's title and site for the first link of a message that got one (the
// server only previews the first, server.py first_link), else the address and its host name.
function makeLinkRow(message, url, index) {
  const row = document.createElement("div");
  row.className = "info-row";
  const preview = index === 0 ? message.preview : null;
  const site = document.createElement("div");
  site.className = "info-site";
  try {
    site.textContent = preview?.site || new URL(url).hostname;  // (?. : preview may be null)
  } catch {
    site.textContent = "";  // (not an address URL() can read)
  }
  const link = makeLink(url);  // (messages.js: a new tab, noopener noreferrer)
  if (preview?.title) link.textContent = preview.title;
  row.append(site, link, makeInfoMeta(message));
  return row;
}

// One file: the same link as in the chat (in the Windows app, with "Download this file?" and its bar).
function makeFileRow(message) {
  const row = document.createElement("div");
  row.className = "info-row";
  row.append(makeFileLink("/uploads/" + encodeURIComponent(message.file.id), message.file, message), makeInfoMeta(message));
  return row;
}

// Under each row: who sent it, when, and Jump.
function makeInfoMeta(message) {
  const meta = document.createElement("div");
  meta.className = "info-meta";
  const who = document.createElement("span");
  const sent = new Date(message.sent_at);
  who.textContent = `${message.name} · ${dayName(sent)} at ${formatClock(sent)}`;  // (textContent: never as HTML)
  if (message.user_id) who.dataset.userMenu = message.user_id;  // (right-click: the user menu)
  meta.append(who, makeCardButton("Jump", () => jumpFromChatInfo(message), true));
  return meta;
}

// On a phone the panel is a drawer over the chat: close it first, so the message can be seen.
function jumpFromChatInfo(message) {
  if (onPhoneLayout()) closeDrawers();
  jumpToMessage(message.id);
}

// A tile was clicked: the picture in the usual viewer (messages.js, openImage), or the video playing
// there, with "Jump to message" under it.
function openMedia(message) {
  const url = "/uploads/" + encodeURIComponent(message.file.id);
  if (message.file.video) {
    viewerImage.hidden = true;
    viewerVideo.hidden = false;
    viewerVideo.src = url;
    viewerVideo.dataset.fileId = message.file.id;
    viewerVideo.volume = videoVolume(message.file.id);  // (messages.js: each video remembers its volume)
    viewer.showModal();
    viewerVideo.play().catch(() => {});  // (a browser may refuse to start it by itself: then press play)
  } else {
    openImage(url, message.file.filename);
  }
  viewerJump.hidden = false;
  viewerJump.onclick = () => {  // (onclick, not addEventListener: one handler, replaced each time)
    viewer.close();
    jumpFromChatInfo(message);
  };
}

viewerVideo.addEventListener("volumechange", () => saveVideoVolume(viewerVideo.dataset.fileId, viewerVideo.volume));
// However the viewer closes: stop the video, and back to how the chat's pictures use it.
viewer.addEventListener("close", () => {
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  viewerVideo.hidden = true;
  viewerImage.hidden = false;
  viewerJump.hidden = true;
});

// Something changed in the chat we're in (core.js): ask again for the open tab if it's affected.
// kind: "message", "edited", "deleted", "preview" or "pinned"; data: the server's message.
function chatInfoNews(kind, data) {
  if (chatInfoTab === null || chatInfoTab === "members") return;
  const hasLink = (text) => /https?:\/\//.test(text ?? "");
  const shown = chatInfoItems.some((message) => message.id === data.message_id);
  const affected = {
    media: (kind === "message" && (data.file?.image || data.file?.video)) || (kind === "deleted" && shown),
    files: (kind === "message" && data.file && !data.file.image && !data.file.video) || (kind === "deleted" && shown),
    links: (kind === "message" && hasLink(data.text)) || kind === "edited" || kind === "preview" || (kind === "deleted" && shown),
    pins: kind === "pinned" || (kind === "deleted" && shown),
  };
  if (affected[chatInfoTab]) loadChatInfo();
}

for (const button of chatInfoTabButtons) {
  button.addEventListener("click", () => showChatInfoTab(button.dataset.tab));
}
document.getElementById("chat-info-close").addEventListener("click", () => {
  closeChatInfo();
  if (onPhoneLayout()) closeDrawers();
});
// The name in the top bar: opens the panel, or closes it again. (A button that's disabled in channels:
// rooms.js, showDmHeader.)
document.getElementById("dm-header-name").addEventListener("click", () => {
  if (chatInfoTab === null) openChatInfo();
  else closeChatInfo();
});
