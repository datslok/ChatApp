// Uploads, messages, reactions, times, replies, editing and deleting. Last file: it
// ends by starting everything (start()).
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ---------- Uploads: the tray, the + button, drag-and-drop and pasting ----------

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;  // 10 MB, same as the server
const MAX_TRAY_FILES = 10;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];  // same as the server

// Files waiting to be sent: [{file, previewUrl, failed}]. Nothing is uploaded until Enter.
const tray = [];
let sending = false;  // true while the tray is being uploaded and sent

// All three ways of adding files (+ button, drop, paste) end up here.
function addToTray(files) {
  for (const file of files) {
    if (file.size > MAX_UPLOAD_SIZE) {
      showUploadError(`${file.name} is too big (max 10 MB)`);
      continue;
    }
    if (file.size === 0) {
      showUploadError(`${file.name} is empty`);
      continue;
    }
    if (tray.length >= MAX_TRAY_FILES) {
      showUploadError(`At most ${MAX_TRAY_FILES} files at a time`);
      break;
    }
    // For pictures, a temporary local address so we can show a preview
    // straight from your computer, without uploading anything yet.
    const previewUrl = IMAGE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null;
    tray.push({ file: file, previewUrl: previewUrl, failed: false });
  }
  renderTray();
  input.focus();  // put the cursor in the text box, ready for a caption or Enter
}

// Take a file out of the tray, and free its preview's memory.
function takeFromTray(item) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  tray.splice(tray.indexOf(item), 1);  // splice(position, 1) removes one element there
  renderTray();
}

// Redraw the tray from the `tray` list.
function renderTray() {
  trayElement.replaceChildren();
  trayElement.hidden = tray.length === 0;

  for (const item of tray) {
    const div = document.createElement("div");
    div.className = "tray-item";
    div.title = item.file.name;  // shows the full name when you hover over it
    if (item.failed) div.classList.add("failed");

    if (item.previewUrl) {
      const img = document.createElement("img");
      img.src = item.previewUrl;
      img.alt = item.file.name;
      div.appendChild(img);
    } else {
      div.classList.add("file");
      div.textContent = `📄 ${item.file.name} (${formatSize(item.file.size)})`;
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.title = "Remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (!sending) takeFromTray(item);
    });
    div.appendChild(remove);

    trayElement.appendChild(div);
  }
}

// Enter was pressed with files in the tray: upload and send each one as its own message.
// The caption goes with the first file that's sent. Files that fail stay in the tray.
async function sendTray(caption) {
  if (socket.readyState !== WebSocket.OPEN) {
    showUploadError("Not connected, try again in a moment");
    return;
  }
  sending = true;

  for (const item of [...tray]) {  // a copy, since we take items out as we go
    const fileId = await uploadFile(item.file);
    const sent = fileId !== null &&
      sendToServer({ type: "message", text: caption, file: fileId, reply_to: replyingTo?.id });
    if (!sent) {
      item.failed = true;  // keep it in the tray, outlined in red
      continue;
    }
    takeFromTray(item);
    clearReply();  // the reply went with this first file
    if (caption) {
      caption = "";      // the caption went with this file, so it's used up
      clearInput();
    }
  }

  sending = false;
  lastTypingSent = 0;
  renderTray();  // show any failed ones in red
}

// Upload one file. Returns its id from the server, or null if it failed (and shows why).
async function uploadFile(file) {
  uploadStatus.className = "";
  uploadStatus.textContent = `Uploading ${file.name}…`;
  let response;
  try {
    // Send the raw file over normal HTTP. The name goes in the URL;
    // encodeURIComponent makes characters like spaces and & safe to put in a URL.
    response = await fetch("/upload?filename=" + encodeURIComponent(file.name), {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
  } catch {
    showUploadError(`Couldn't upload ${file.name}`);  // network trouble
    return null;
  }
  if (!response.ok) {
    // Show the server's reason if it gave one, e.g. "Files can be at most 10 MB."
    const error = await response.json().catch(() => ({}));
    showUploadError(typeof error.detail === "string" ? error.detail : `Couldn't upload ${file.name}`);
    return null;
  }
  uploadStatus.textContent = "";
  const data = await response.json();  // {"id": "..."}
  return data.id;
}

function showUploadError(text) {
  uploadStatus.className = "error";
  uploadStatus.textContent = text;
  setTimeout(() => {
    if (uploadStatus.textContent === text) uploadStatus.textContent = "";
  }, 5000);
}

// 1. The + button opens the browser's file picker (the hidden <input type="file">).
attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addToTray([...fileInput.files]);  // copy the list first...
  fileInput.value = "";               // ...then reset, so the same file can be picked again
});

// 2. Drag-and-drop. Only react to dragged *files* (not, say, a bit of selected text).
function isDraggingFiles(event) {
  return event.dataTransfer.types.includes("Files");
}

chat.addEventListener("dragover", (event) => {
  if (!isDraggingFiles(event) || currentChannel === FRIENDS || currentChannel === LOUNGE) return;  // (nowhere to send it there)
  event.preventDefault();  // required, or the browser won't let us accept the drop
  dropOverlay.hidden = false;
});
// Once shown, the overlay covers the whole chat, so leaving the overlay = leaving the chat.
dropOverlay.addEventListener("dragleave", () => {
  dropOverlay.hidden = true;
});
dropOverlay.addEventListener("drop", (event) => {
  event.preventDefault();  // stop the browser from opening the file itself
  dropOverlay.hidden = true;
  addToTray([...event.dataTransfer.files]);
});
// Dropped somewhere else on the page (like the sidebar)? Then the browser would open the
// file and leave the chat. Prevent that everywhere; only the chat area accepts drops.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dropOverlay.hidden = true;  // the drag is over, wherever it ended
});

// A drag can also end without a drop or dragleave on the overlay: Windows refusing to drop
// a shortcut, Esc in the middle of a drag. Then the overlay must not stay stuck on the chat:
// - the drag left the window (relatedTarget null = to somewhere outside the page): hide it;
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) dropOverlay.hidden = true;
});
// - and if it's still showing anyway, a click or Esc hides it (nobody can click mid-drag).
dropOverlay.addEventListener("click", () => {
  dropOverlay.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dropOverlay.hidden = true;
});

// 3. Pasting: a copied screenshot or image arrives as a file on the clipboard.
document.addEventListener("paste", (event) => {
  const files = [...event.clipboardData.files];
  if (files.length === 0) return;  // just text: let the normal paste happen
  if (currentChannel === FRIENDS || currentChannel === LOUNGE) return;  // no channel to send it to
  event.preventDefault();
  addToTray(files);
});

// ---------- Image popup ----------

function openImage(url, name) {
  viewerImage.src = url;
  viewerImage.alt = name;
  viewer.showModal();  // open as a modal: on top of everything; Esc closes it
}

// A click on the picture has the <img> as its target; a click on the dark area
// around it has the dialog itself as the target. Only the second one closes it.
viewer.addEventListener("click", (event) => {
  if (event.target === viewer) viewer.close();
});
viewerClose.addEventListener("click", () => viewer.close());
// However it was closed (Esc, outside, ×), drop the picture so the next one
// doesn't briefly show the old one while loading.
viewer.addEventListener("close", () => viewerImage.removeAttribute("src"));

// ---------- Messages ----------

// Turn a size in bytes into something readable, like "2.3 MB".
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// The element showing an attached file: the picture itself, or a download link.
function makeAttachment(file) {
  const url = "/uploads/" + encodeURIComponent(file.id);
  const link = document.createElement("a");
  link.href = url;

  if (file.image) {
    // A normal click opens the popup instead of following the link. Middle-click or
    // right-click > "Open in new tab" still work, since they don't fire "click".
    link.target = "_blank";
    link.rel = "noopener";  // a new tab gets no access back to ours
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openImage(url, file.filename);
    });
    const img = document.createElement("img");
    img.className = "attachment-image";
    img.src = url;
    img.alt = file.filename;
    link.appendChild(img);
  } else {
    link.className = "attachment-file";
    link.textContent = `📄 ${file.filename} (${formatSize(file.size)})`;
  }
  return link;
}

// ---------- Reactions ----------

const emojiPicker = document.getElementById("emoji-picker");
const emojiSearch = document.getElementById("emoji-search");
const emojiCategories = document.getElementById("emoji-categories");
const emojiGrid = document.getElementById("emoji-grid");

let emojiGroups = null;       // [{name, emoji: [[emoji, name], ...]}, ...], loaded once from /emoji.json
const emojiNames = new Map(); // emoji -> its name, for tooltips and search

// Custom emoji, from the server's "custom_emoji" message: [{id, name, file, owner_id}, ...].
// A reaction refers to one as "custom:17" (its id), so renaming would never break anything.
let customEmoji = [];
const customById = new Map();

function setCustomEmoji(list) {
  customEmoji = list;
  customById.clear();
  for (const emoji of list) customById.set(emoji.id, emoji);
  if (!emojiPicker.hidden) {  // the picker is open: show the new list straight away
    buildCategoryButtons();
    renderEmojiGrid(emojiSearch.value);
  }
  if (settingsDialog.open) renderMyEmoji();
}

// How to show an emoji: a custom one as a little picture, a normal one as text.
function makeEmojiElement(value) {
  if (value.startsWith("custom:")) {
    const custom = customById.get(Number(value.slice("custom:".length)));
    const img = document.createElement("img");
    img.className = "custom-emoji";
    if (custom) {
      img.src = "/custom-emoji/files/" + encodeURIComponent(custom.file);
      img.alt = ":" + custom.name + ":";
    }
    return img;
  }
  const span = document.createElement("span");
  span.className = "emoji";
  span.textContent = value;
  return span;
}

// The name shown when hovering an emoji: "grinning face", or ":pog:".
function emojiLabel(value) {
  if (value.startsWith("custom:")) {
    const custom = customById.get(Number(value.slice("custom:".length)));
    return custom ? ":" + custom.name + ":" : "deleted emoji";
  }
  return emojiNames.get(value) || value;
}

// Is this emoji still usable? (A custom one may have been deleted since.)
function emojiExists(value) {
  return value.startsWith("custom:") ? customById.has(Number(value.slice("custom:".length))) : emojiNames.has(value);
}
let pickerMessageId = null;   // which message the open picker is for
const RECENT_KEY = "recentEmoji";
const MAX_RECENT = 24;

// Recently used emoji, remembered in this browser (like a remembered tab: nice, not essential,
// so if the browser refuses storage, we simply don't remember).
function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function rememberRecent(emoji) {
  // Put it first, remove it from further down, keep at most MAX_RECENT.
  const recent = [emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {}
}

// React to a message: add our reaction, or remove it if it's already there. The server
// answers everyone in the channel with the message's new reactions.
function react(messageId, emoji) {
  sendToServer({ type: "react", message_id: messageId, emoji: emoji });
}

// The picker has two modes: "react" (from a message's 😀: clicking an emoji reacts) and
// "insert" (from the text box's 😀: clicking an emoji types it into the message).
let pickerMode = "react";

// Load the list of all emoji (once). Used by the picker and by the autocomplete.
let emojiDataLoading = null;
function ensureEmojiData() {
  // The first call starts loading; later calls get the same Promise, so it's only fetched once.
  emojiDataLoading ??= (async () => {  // ??= : "assign only if it's still null/undefined"
    const response = await fetch("/emoji.json");
    emojiGroups = (await response.json()).groups;
    for (const group of emojiGroups) {
      for (const [emoji, name] of group.emoji) emojiNames.set(emoji, name);
    }
  })();
  return emojiDataLoading;
}

async function openEmojiPicker(messageId, button, mode = "react") {
  pickerMessageId = messageId;
  pickerMode = mode;
  await ensureEmojiData();
  buildCategoryButtons();  // (every time: the ⭐ button depends on the mode)
  emojiSearch.value = "";
  renderEmojiGrid("");
  emojiPicker.hidden = false;
  placePicker(button);
  emojiGrid.scrollTop = 0;
  if (window.innerWidth > 700) emojiSearch.focus();  // (on phones, focusing would pop up the keyboard)
}

function closeEmojiPicker() {
  emojiPicker.hidden = true;
  pickerMessageId = null;
}

// Put the picker next to the 😀 button: below it, or above if there's no room below,
// and never off the edge of the window. (On phones, the CSS makes it a bottom panel instead.)
function placePicker(button) {
  emojiPicker.style.top = "";
  emojiPicker.style.left = "";
  if (window.innerWidth <= 700) return;
  const spot = button.getBoundingClientRect();  // where the button is on screen
  const height = emojiPicker.offsetHeight;
  const width = emojiPicker.offsetWidth;
  let top = spot.bottom + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, spot.top - height - 4);
  const left = Math.max(8, Math.min(spot.right - width, window.innerWidth - width - 8));
  emojiPicker.style.top = top + "px";
  emojiPicker.style.left = left + "px";
}

// One button per category (showing its first emoji) that scrolls the grid to that category.
// A ⭐ button for the custom emoji comes first, if there are any.
function buildCategoryButtons() {
  emojiCategories.replaceChildren();
  const categories = [];
  if (customEmoji.length) categories.push(["⭐", "Custom", "emoji-group-custom"]);
  emojiGroups.forEach((group, index) => {  // forEach: like a for loop, but also gives the position
    categories.push([group.emoji[0][0], group.name, "emoji-group-" + index]);
  });
  for (const [icon, name, anchorId] of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji";
    button.textContent = icon;
    button.title = name;
    button.addEventListener("click", () => {
      if (emojiSearch.value) {
        emojiSearch.value = "";
        renderEmojiGrid("");
      }
      document.getElementById(anchorId).scrollIntoView({ block: "start" });
    });
    emojiCategories.appendChild(button);
  }
}

// The custom emoji grouped by who added them: ours first, then everyone else's by name.
// Returns [[title, [[value, name], ...]], ...].
function customSections() {
  const byOwner = new Map();
  for (const emoji of customEmoji) {
    if (!byOwner.has(emoji.owner_id)) byOwner.set(emoji.owner_id, []);
    byOwner.get(emoji.owner_id).push(["custom:" + emoji.id, ":" + emoji.name + ":"]);
  }
  const ownerName = (id) => people.get(id)?.name ?? "someone";
  const owners = [...byOwner.keys()].sort((a, b) => {
    if (a === myId) return -1;  // ours first
    if (b === myId) return 1;
    return ownerName(a).localeCompare(ownerName(b));  // then alphabetical
  });
  return owners.map((id) => [id === myId ? "Your emoji" : `${ownerName(id)}'s emoji`, byOwner.get(id)]);
}

// Fill the grid: search results, or "Recently used" plus every category.
function renderEmojiGrid(query) {
  emojiGrid.replaceChildren();

  function section(title, list, anchorId) {
    const heading = document.createElement("h4");
    heading.className = "emoji-section-title";
    heading.textContent = title;
    if (anchorId) heading.id = anchorId;
    emojiGrid.appendChild(heading);
    const row = document.createElement("div");
    row.className = "emoji-row";
    for (const [emoji, name] of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.appendChild(makeEmojiElement(emoji));
      button.title = name;
      button.addEventListener("click", () => {
        rememberRecent(emoji);
        if (pickerMode === "insert") {
          // A custom emoji is typed as its code (":pog:"), which the server turns into the picture.
          insertAtCursor(emoji.startsWith("custom:") ? emojiLabel(emoji) : emoji);  // the picker stays open
        } else {
          react(pickerMessageId, emoji);
          closeEmojiPicker();
        }
      });
      row.appendChild(button);
    }
    emojiGrid.appendChild(row);
  }

  const search = query.trim().toLowerCase();
  if (search) {
    const results = [];
    for (const emoji of customEmoji) {  // custom emoji first: they're what people search for most
      if (emoji.name.toLowerCase().includes(search)) results.push(["custom:" + emoji.id, ":" + emoji.name + ":"]);
    }
    for (const group of emojiGroups) {
      for (const entry of group.emoji) {
        if (entry[1].includes(search)) results.push(entry);
      }
    }
    section(results.length ? "Search results" : "No emoji found", results.slice(0, 300));
    return;
  }

  const recent = loadRecent().filter(emojiExists);
  if (recent.length) section("Recently used", recent.map((emoji) => [emoji, emojiLabel(emoji)]));
  customSections().forEach(([title, list], index) => {
    section(title, list, index === 0 ? "emoji-group-custom" : null);  // the ⭐ button scrolls to the first
  });
  emojiGroups.forEach((group, index) => section(group.name, group.emoji, "emoji-group-" + index));
}

emojiSearch.addEventListener("input", () => renderEmojiGrid(emojiSearch.value));

// Close the picker when clicking anywhere outside it (except the 😀 buttons, which open it),
// or pressing Esc.
document.addEventListener("pointerdown", (event) => {
  if (emojiPicker.hidden) return;
  if (emojiPicker.contains(event.target) || event.target.closest(".open-picker")) return;
  closeEmojiPicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !emojiPicker.hidden) closeEmojiPicker();
});

// The chips under a message: "👍 3", highlighted if we reacted too. Click to add/remove ours.
function renderReactions(container, messageId, reactions) {
  container.replaceChildren();
  for (const reaction of reactions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction-chip";
    if (reaction.user_ids.includes(myId)) chip.classList.add("mine");
    const count = document.createElement("span");
    count.textContent = reaction.user_ids.length;
    chip.append(makeEmojiElement(reaction.emoji), count);
    // Which emoji, and who reacted, by their *current* names. ?. and ??: "someone" if we don't know them.
    const names = reaction.user_ids.map((id) => people.get(id)?.name ?? "someone").join(", ");
    chip.title = reaction.emoji.startsWith("custom:") ? `${emojiLabel(reaction.emoji)} ${names}` : names;
    chip.addEventListener("click", () => react(messageId, reaction.emoji));
    container.appendChild(chip);
  }
}

// Is this text only emoji (and spaces)? Then it's shown big ("jumbo"), like Discord.
// \p{...} in a regular expression (with the u flag) matches a whole Unicode category:
// Extended_Pictographic = emoji pictures, Regional_Indicator = the letters flags are made of.
// Also removed: skin tones (1F3FB-1F3FF), the "glue" between combined emoji (200D), the
// "show as emoji" mark (FE0F) and the keycap mark (20E3). Anything left over = not only emoji.
// (Digits aren't removed: "123" is not jumbo, even though 1️⃣ is made from a digit.)
const EMOJI_PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu;
const EMOJI_PARTS = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|‍|️|⃣|\s/gu;
const MAX_JUMBO_EMOJI = 27;

// A custom emoji in a message's text: a token with its id, like <:17> (the server turned
// ":pog:" into that when it was sent).
const CUSTOM_EMOJI_TOKEN = /<:\d+>/g;

function isOnlyEmoji(text) {
  // match() gives null when there's nothing, hence the || [].
  const count = (text.match(EMOJI_PICTURE) || []).length + (text.match(CUSTOM_EMOJI_TOKEN) || []).length;
  const leftover = text.replace(CUSTOM_EMOJI_TOKEN, "").replace(EMOJI_PARTS, "");
  return count > 0 && count <= MAX_JUMBO_EMOJI && leftover === "";
}

// Put message text into an element, with tokens shown as what they mean: custom emoji (<:17>)
// as their pictures, mentions (<@2>, <@everyone>) as @name chips, and (if withLinks) web
// addresses as links. Still never innerHTML: the text goes in as text nodes, the rest as elements.
function fillWithEmoji(element, text, withLinks) {
  element.replaceChildren();
  // split() with a (group) in the pattern keeps what the group matched: the tokens' insides end
  // up at the odd positions, the text around them at the even ones.
  // "hi <:17> and <@2>!" -> ["hi ", ":17", " and ", "@2", "!"]
  text.split(/<(:\d+|@\d+|@everyone)>/).forEach((part, index) => {
    if (index % 2 === 0) {
      if (withLinks) appendWithLinks(element, part);
      else if (part) element.appendChild(document.createTextNode(part));
    } else if (part.startsWith(":")) {
      const id = part.slice(1);
      if (customById.has(Number(id))) {
        const picture = makeEmojiElement("custom:" + id);
        picture.title = emojiLabel("custom:" + id);  // ":pog:" when hovering it
        element.appendChild(picture);
      } else {
        element.appendChild(document.createTextNode(":deleted:"));  // that emoji no longer exists
      }
    } else {
      element.appendChild(makeMentionChip(part.slice(1)));  // "2" or "everyone"
    }
  });
}

// A web address: http:// or https://, then everything up to a space (or a "<", which can't
// be part of one). Only these two kinds: a link to "javascript:..." would run code when clicked.
const URL_PATTERN = /https?:\/\/[^\s<]+/g;

// Text with its web addresses as links, the rest as text nodes.
function appendWithLinks(element, text) {
  let position = 0;  // how far into the text we've added
  // matchAll() finds every address; each match knows where in the text it starts (.index).
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (match.index > position) {
      element.appendChild(document.createTextNode(text.slice(position, match.index)));
    }
    element.appendChild(makeLink(url));
    position = match.index + url.length;  // what trimUrl cut off is added as text next time
  }
  if (position < text.length) element.appendChild(document.createTextNode(text.slice(position)));
}

// Punctuation at the end of an address usually belongs to the sentence: "see https://x.com."
// A ")" stays if the address has a "(" of its own, like Wikipedia's ".../Python_(language)".
function trimUrl(url) {
  while (true) {
    const last = url.slice(-1);
    const opens = url.split("(").length - 1;   // how many "(" (pieces minus one)
    const closes = url.split(")").length - 1;
    if (".,!?:;'\"".includes(last) || (last === ")" && closes > opens)) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

function makeLink(url) {
  const link = document.createElement("a");
  link.className = "message-link";
  link.href = url;
  link.textContent = url;
  link.target = "_blank";  // a new tab, so the chat stays open
  // noopener: the new page gets no handle back to our tab (it could send it to a fake login page).
  // noreferrer: and it isn't told which page the click came from.
  link.rel = "noopener noreferrer";
  return link;
}

// "@kari", highlighted. Shows the person's *current* name; click for their profile.
function makeMentionChip(who) {
  const chip = document.createElement("span");
  chip.className = "mention";
  if (who === "everyone") {
    chip.textContent = "@everyone";
    return chip;
  }
  const person = people.get(Number(who));
  chip.textContent = "@" + (person ? person.name : "unknown");
  if (person) {
    chip.classList.add("clickable");
    chip.addEventListener("click", (event) => {
      event.stopPropagation();  // just this, not also the message's own click handling
      openProfile(person.id);
    });
  }
  return chip;
}

// Does this text mention us (by name, or with @everyone)?
function mentionsMe(text) {
  return text.includes(`<@${myId}>`) || text.includes("<@everyone>");
}

// ---------- Times ----------
// Times arrive as "2026-10-10T14:03:12Z" (UTC). new Date(...) turns that into a moment in time,
// and the toLocale...String functions show it in the viewer's own time zone and language.

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });  // "14:03"
}

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();  // e.g. "Sat Oct 10 2026", in local time
}

function dayName(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);  // (setDate handles month and year changes too)
  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });  // "10 October 2026"
}

// ---------- Messages ----------

// The last message drawn: its sender and time. A new message from the same sender, on the
// same day and within GROUP_MINUTES, joins its group (drawn without picture and name).
const GROUP_MINUTES = 5;
let lastShown = null;

// ---------- Replies ----------

let replyingTo = null;  // {id, name} of the message we're replying to, or null

function startReply(messageId, name) {
  replyingTo = { id: messageId, name: name };
  replyName.textContent = name;
  replyBar.hidden = false;
  input.focus();  // ready to type the reply
}

function clearReply() {
  replyingTo = null;
  replyBar.hidden = true;
}

replyCancel.addEventListener("click", clearReply);
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && replyingTo) clearReply();
});

// The quote above a reply: "↪ (picture) kari: are you coming tonig…". Click it to jump there.
function makeReplyLine(reply) {
  const line = document.createElement("div");
  if (reply.deleted) {
    line.className = "reply-line deleted";
    line.textContent = "↪ Original message was deleted";
    return line;
  }
  line.className = "reply-line clickable";
  line.appendChild(document.createTextNode("↪ "));
  line.appendChild(makeAvatar(reply.user_id, reply.name, "tiny"));
  const name = document.createElement("strong");
  name.textContent = reply.name;
  line.appendChild(name);
  const text = document.createElement("span");
  text.className = "reply-text";
  if (reply.text) {
    fillWithEmoji(text, reply.text);
  } else {
    text.textContent = reply.file ? "📎 Attachment" : "";
  }
  line.appendChild(text);
  line.addEventListener("click", () => jumpToMessage(reply.id));
  return line;
}

// Scroll to a message and light it up briefly, if it's on the page.
function jumpToMessage(messageId) {
  // The id is a number from the server, so it's safe to put in a CSS selector.
  const target = messages.querySelector(`[data-id="${messageId}"]`);
  if (!target) {
    // Only the newest messages are loaded, so older ones can't be shown (yet).
    showUploadError("That message is too old to show here.");
    return;
  }
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  // Restart the highlight animation, even if it was already running: remove the class,
  // make the browser notice (reading offsetWidth forces it to work out the layout), add it back.
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}

// ---------- Editing and deleting ----------

// The channel's messages, as the server sent them (and as edits/deletes/reactions changed them).
// Deleting one can change its neighbours (if the first of a group goes, the next needs its
// picture and name), so instead of patching the screen, we redraw everything from this list.
let shownMessages = [];
let editingId = null;  // the message being edited right now, if any
let editDraft = "";    // what's typed in its edit box (kept here, so a redraw doesn't lose it)

function amAdmin() {
  return people.get(myId)?.admin === true;
}

// May we edit/delete this message? Our own, or anyone's if we're an admin.
function canModify(message) {
  return message.user_id === myId || amAdmin();
}

// Redraw all messages from shownMessages, keeping the scroll position.
function redrawMessages() {
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
  const scrollTop = messages.scrollTop;
  messages.replaceChildren();
  lastShown = null;
  for (const message of shownMessages) showMessage(message);
  messages.scrollTop = atBottom ? messages.scrollHeight : scrollTop;
}

// In the text, custom emoji are tokens like <:17>. In an edit box we show ":pog:" again.
// (And mentions: <@2> -> "@kari", <@everyone> -> "@everyone".)
function tokensToCodes(text) {
  return text
    .replace(/<:(\d+)>/g, (token, id) => customById.has(Number(id)) ? emojiLabel("custom:" + id) : ":deleted:")
    .replace(/<@everyone>/g, "@everyone")
    .replace(/<@(\d+)>/g, (token, id) => "@" + (people.get(Number(id))?.name ?? "unknown"));
}

function startEdit(message) {
  editingId = message.id;
  editDraft = tokensToCodes(message.text);
  redrawMessages();
}

function stopEditing() {
  editingId = null;
  redrawMessages();
  input.focus();
}

function saveEdit(message) {
  const text = editDraft.trim();
  if (text === tokensToCodes(message.text).trim()) return stopEditing();  // nothing changed
  if (!text && !message.file) {
    // Emptied completely: that's really a delete (like on Discord).
    stopEditing();
    deleteMessage(message, false);
    return;
  }
  sendToServer({ type: "edit", message_id: message.id, text: text });
  stopEditing();  // the server's "edited" message will show the new text
}

function deleteMessage(message, skipConfirm) {
  // confirm() shows the browser's own OK/Cancel box. Shift+click skips it.
  if (skipConfirm || confirm("Delete this message?")) {
    sendToServer({ type: "delete", message_id: message.id });
  }
}

// The edit box shown in place of a message's text.
function makeEditor(message) {
  const box = document.createElement("div");
  box.className = "editor";
  const area = document.createElement("textarea");
  area.className = "edit-input";
  area.maxLength = maxTextLength;
  area.value = editDraft;
  const grow = () => {
    area.style.height = "auto";
    area.style.height = area.scrollHeight + "px";
  };
  area.addEventListener("input", () => {
    editDraft = area.value;
    grow();
  });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      saveEdit(message);
    } else if (event.key === "Escape") {
      stopEditing();
    }
  });
  box.appendChild(area);

  const hint = document.createElement("div");
  hint.className = "editor-hint";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "save";
  save.addEventListener("click", () => saveEdit(message));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", stopEditing);
  hint.append("Enter to ", save, " · Esc to ", cancel);  // append() takes text and elements
  box.appendChild(hint);

  // Once it's on the page: focus it, cursor at the end, right height.
  setTimeout(() => {
    area.focus();
    area.selectionStart = area.selectionEnd = area.value.length;
    grow();
  }, 0);
  return box;
}

// A line across the chat with the day in the middle, between messages from different days.
function makeDateDivider(date) {
  const divider = document.createElement("div");
  divider.className = "date-divider";
  divider.textContent = dayName(date);
  return divider;
}

// Add one message to the bottom of the #messages box.
// Built piece by piece with textContent, never innerHTML: names and text are
// shown as-is, so neither can ever run as code.
function showMessage(message) {
  // Were we scrolled to (or near) the bottom before this message arrived?
  // (Measured before adding anything, including a date divider.)
  const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  const wasAtBottom = distanceFromBottom < 50;

  const time = new Date(message.sent_at);
  // Who sent it: the user id, or for messages from before accounts existed, the typed name.
  const sender = message.user_id ?? "name:" + message.name;

  // A new day? Then a date divider first.
  const newDay = lastShown === null || !isSameDay(lastShown.time, time);
  if (newDay) messages.appendChild(makeDateDivider(time));

  // Part of the previous message's group? (time - time gives milliseconds.)
  // A reply always starts a new group, so its quote line sits above a name, not mid-group.
  const grouped = !newDay && !message.reply && lastShown.sender === sender &&
    time - lastShown.time < GROUP_MINUTES * 60 * 1000;
  lastShown = { sender: sender, time: time };

  const div = document.createElement("div");
  div.className = grouped ? "message grouped" : "message";
  if (mentionsMe(message.text)) div.classList.add("mentions-me");  // highlighted for us
  if (message.kind === "call") div.classList.add("call-note");     // "📞 Call · 12 min", written by the server
  div.dataset.id = message.id;  // so features like replies (jumping to the original) can find it

  // The buttons that appear when hovering a message (more will join Reply later).
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.textContent = "↩ Reply";
  replyButton.addEventListener("click", () => startReply(message.id, message.name));
  const reactButton = document.createElement("button");
  reactButton.type = "button";
  reactButton.className = "emoji open-picker";
  reactButton.textContent = "😀";
  reactButton.title = "Add reaction";
  reactButton.addEventListener("click", () => openEmojiPicker(message.id, reactButton));
  actions.append(reactButton, replyButton);
  if (canModify(message)) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.textContent = "✏️";
    editButton.title = "Edit";
    editButton.addEventListener("click", () => startEdit(message));
    if (message.kind === "call") editButton.hidden = true;  // call notes can be deleted, not edited
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "🗑️";
    deleteButton.title = "Delete (hold Shift to skip the question)";
    deleteButton.addEventListener("click", (event) => deleteMessage(message, event.shiftKey));
    actions.append(editButton, deleteButton);
  }
  div.appendChild(actions);

  const body = document.createElement("div");
  body.className = "message-body";
  if (message.reply) body.appendChild(makeReplyLine(message.reply));

  if (grouped) {
    // No picture or name: just the time on the left, shown when hovering.
    const hoverTime = document.createElement("span");
    hoverTime.className = "hover-time";
    hoverTime.textContent = formatClock(time);
    hoverTime.title = time.toLocaleString();  // the full date and time, when hovering it
    div.appendChild(hoverTime);
  } else {
    // The sender's picture on the left. Pictures and names open their profile when clicked
    // (except for messages from before accounts existed, which have no profile).
    const avatar = makeAvatar(message.user_id, message.name, "");
    div.appendChild(avatar);

    // The header: name, and when it was sent ("Today at 14:03").
    const header = document.createElement("div");
    header.className = "message-header";
    const nameElement = document.createElement("span");
    nameElement.className = "name";
    nameElement.textContent = message.name;
    header.appendChild(nameElement);
    const timeElement = document.createElement("span");
    timeElement.className = "message-time";
    const day = dayName(time);
    timeElement.textContent = (day === "Today" || day === "Yesterday" ? day + " at " : day + " ") + formatClock(time);
    timeElement.title = time.toLocaleString();
    header.appendChild(timeElement);
    body.appendChild(header);

    if (message.user_id) {
      avatar.classList.add("clickable");
      nameElement.classList.add("clickable");
      // The click handler goes on the message, not on the picture: pictures get swapped
      // for fresh ones when someone changes theirs, and a handler on the old one would be lost.
      div.addEventListener("click", (event) => {
        if (event.target.closest(".reply-line")) return;  // the quote line jumps instead (its tiny picture too)
        if (event.target.closest(".avatar, .name")) openProfile(message.user_id);
      });
    }
  }

  if (editingId === message.id) {
    body.appendChild(makeEditor(message));  // being edited: an edit box instead of the text
  } else if (message.text) {
    const text = document.createElement("div");
    text.className = isOnlyEmoji(message.text) ? "message-text jumbo" : "message-text";
    fillWithEmoji(text, message.text, true);
    if (message.edited_at) {
      const label = document.createElement("span");
      label.className = "edited-label";
      label.textContent = " (edited)";
      label.title = "Edited " + new Date(message.edited_at).toLocaleString();
      text.appendChild(label);
    }
    body.appendChild(text);
  }
  if (message.file) {
    body.appendChild(makeAttachment(message.file));
  }
  // The reaction chips (an empty row is hidden by the CSS).
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  renderReactions(reactions, message.id, message.reactions || []);
  body.appendChild(reactions);
  div.appendChild(body);

  // A picture only gets its real height once it has loaded, which pushes the
  // messages up after we've scrolled. So scroll again when it finishes loading.
  // (Only the attached picture: profile pictures always have the same fixed size.)
  const img = div.querySelector(".attachment-image");
  if (img && wasAtBottom) {
    img.addEventListener("load", () => {
      messages.scrollTop = messages.scrollHeight;
    });
  }

  messages.appendChild(div);

  // Only follow new messages if we were already at the bottom,
  // so we don't yank someone away from older messages they're reading.
  if (wasAtBottom) {
    messages.scrollTop = messages.scrollHeight;
  }
}

start();
