// Settings: profile, custom emoji, the picture editor (move and zoom before uploading).
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ---------- Settings ----------

settingsButton.addEventListener("click", async () => {
  closeDrawers();  // on a phone, the sidebar drawer was open
  usernameForm.reset();  // empty the fields from last time
  usernameStatus.textContent = "";
  emailForm.reset();
  passwordForm.reset();
  emailStatus.textContent = "";
  passwordStatus.textContent = "";
  profileStatusLine.textContent = "";
  emojiStatus.textContent = "";
  feedbackStatus.textContent = "";  // (a half-written report stays, in case Settings was closed by mistake)
  renderMyEmoji();
  loadInbox();  // (admins only: the bug reports and ideas, fetched fresh)
  showNotificationSettings();  // (the browser's permission may have changed since)
  settingsDialog.showModal();
  showSettingsPage(settingsPage);  // the tab from last time, in sight (on a phone) and from the top

  // Ask the server for our current details, to show them.
  const response = await fetch("/me");
  if (response.ok) {
    const me = await response.json();  // {username, email, avatar, status, bio}
    currentUsername.textContent = me.username;
    currentEmail.textContent = me.email || "none yet";
    statusInput.value = me.status || "";
    bioInput.value = me.bio || "";
    settingsAvatar.replaceChildren(makeAvatar(myId, me.username, "large"));
    settingsBanner.replaceChildren(makeBanner(myId));
  }
});
settingsClose.addEventListener("click", () => settingsDialog.close());

// ----- The tabs down the left side: one page of settings at a time. Each tab button has a
// data-tab="voice" and its page a data-page="voice" (index.html); button.dataset.tab reads it.
const settingsTabs = document.querySelectorAll(".settings-tab");
const settingsPages = document.querySelectorAll(".settings-page");
const settingsPagesBox = document.getElementById("settings-pages");
let settingsPage = "account";  // the one showing; Settings opens on it again (until a reload)

function showSettingsPage(name) {
  if (name !== settingsPage) stopSettingsTests();  // leaving Voice or Video: mic and camera off
  settingsPage = name;
  for (const page of settingsPages) page.hidden = page.dataset.page !== name;
  for (const tab of settingsTabs) {
    const chosen = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", chosen ? "true" : "false");
    // On a phone the tabs are a row you swipe: bring the chosen one into sight ("nearest": only
    // as far as needed, and nothing at all when it's already visible, as on a computer).
    if (chosen && settingsDialog.open) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  settingsPagesBox.scrollTop = 0;  // start at the top of the new page
  if (name === "changelog" && settingsDialog.open) showChangelog();  // (also marks it as seen)
}

for (const tab of settingsTabs) {
  tab.addEventListener("click", () => showSettingsPage(tab.dataset.tab));
}
showSettingsPage(settingsPage);  // at the start: hide every page but the first

// ---------- Settings: What's new ----------
//
// Written by hand in static/changelog.json, in two parts:
//   "changes":  what changed when, newest day first: [{"date": "2026-10-12", "items": [...]}]
//   "features": everything the chat can do, by topic: [{"topic": "💬 Messages", "items": [...]}]
// This browser remembers a fingerprint of the "changes" it has shown (localStorage
// "changelogSeen"). Any change there (a new line, or an edited one) gives a different
// fingerprint, which puts a red dot on ⚙️ and on the tab. Editing "features" alone doesn't.

const settingsNewDot = document.getElementById("settings-new-dot");
const changelogNewDot = document.getElementById("changelog-new-dot");
const changesBox = document.getElementById("changelog-changes");
const featuresBox = document.getElementById("changelog-features");
let changelog = { features: [], changes: [] };  // the file's contents, once fetched

async function loadChangelog() {
  try {
    const response = await fetch("/changelog.json");
    if (!response.ok) return;
    changelog = await response.json();  // (JSON text -> an object with the two lists)
  } catch {
    return;  // offline or a broken file: no dots, and the page stays empty
  }
  updateChangelogDots();
}

// A short fingerprint of the changes: the same text always gives the same number, and any
// change to it almost certainly a different one. (A simple "hash": each character's code
// mixes into the number so far. Math.imul multiplies like 32-bit whole numbers do, and ">>> 0"
// keeps the result a positive number.)
function changesFingerprint() {
  const text = JSON.stringify(changelog.changes);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) >>> 0;
  }
  return String(hash);
}

function updateChangelogDots() {
  const unseen = changelog.changes.length > 0 && changesFingerprint() !== localStorage.getItem("changelogSeen");
  settingsNewDot.hidden = !unseen;
  changelogNewDot.hidden = !unseen;
}

// One card: a title over a list of lines, formatted like messages (messages.js, formatText),
// so **bold**, `code` and the rest work in them.
function makeChangelogCard(title, items) {
  const card = document.createElement("article");
  card.className = "changelog-card";
  const list = document.createElement("ul");
  for (const item of items) {
    const line = document.createElement("li");
    line.className = "message-text";
    formatText(line, item);
    list.appendChild(line);
  }
  card.append(title, list);
  return card;
}

// Draw both parts (each in its own section, index.html), and remember that we've seen the changes.
function showChangelog() {
  changesBox.replaceChildren();
  for (const entry of changelog.changes) {
    const date = document.createElement("time");
    date.className = "changelog-title";
    date.dateTime = entry.date;
    // "T12:00": midday, so the date is the same in every time zone (just "2026-10-12" means
    // midnight in London, which is still the day before further west).
    date.textContent = new Date(entry.date + "T12:00").toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
    changesBox.appendChild(makeChangelogCard(date, entry.items));
  }
  featuresBox.replaceChildren();
  for (const group of changelog.features) {
    const topic = document.createElement("div");
    topic.className = "changelog-title";
    topic.textContent = group.topic;
    featuresBox.appendChild(makeChangelogCard(topic, group.items));
  }
  if (changelog.changes.length > 0) localStorage.setItem("changelogSeen", changesFingerprint());
  updateChangelogDots();
}

loadChangelog();

// ---------- Settings: profile ----------

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await postJson("/settings/profile", { status: statusInput.value, bio: bioInput.value });
  if (result.ok) {
    showStatus(profileStatusLine, "Profile saved.", "success");
  } else {
    showStatus(profileStatusLine, result.error, "error");
  }
});

// Profile picture ("avatar") and banner work the same way. Picking a file opens the editor
// (move and zoom); nothing is uploaded until Save there.
function setUpPictureButtons(kind, changeButton, removeButton, fileInput) {
  changeButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";  // so the same file can be picked again later
    if (!file) return;
    // Animated GIFs are uploaded whole (the server crops them), so they may be bigger.
    if (file.type === "image/gif" && file.size > 10 * 1024 * 1024) {
      showStatus(profileStatusLine, "GIFs can be at most 10 MB.", "error");
      return;
    }
    try {
      openCropper(await loadPicture(file), kind, file);
    } catch {
      showStatus(profileStatusLine, "Couldn't read that picture. Try a PNG or JPEG.", "error");
    }
  });

  removeButton.addEventListener("click", async () => {
    const response = await fetch("/settings/" + kind, { method: "DELETE" });
    if (response.ok) showStatus(profileStatusLine, "Removed.", "success");
  });
}

setUpPictureButtons("avatar", changeAvatarButton, removeAvatarButton, avatarInput);
setUpPictureButtons("banner", changeBannerButton, removeBannerButton, bannerInput);

// ---------- Settings: custom emoji ----------

const MAX_CUSTOM_EMOJI = 12;
let pendingEmojiName = "";  // the name for the emoji being edited/uploaded
// The emoji getting a new picture ({id, name, ...}), or null when adding a new one. Replacing
// keeps its id, so the messages and reactions that use it show the new picture.
let replacingEmoji = null;

// One custom emoji with its name (and, for others' emoji, whose it is), Replace and Delete buttons.
function makeEmojiItem(emoji, showOwner) {
  const item = document.createElement("div");
  item.className = "my-emoji-item";
  item.appendChild(makeEmojiElement("custom:" + emoji.id));
  const name = document.createElement("span");
  name.textContent = ":" + emoji.name + ":" + (showOwner ? ` (${people.get(emoji.owner_id)?.name ?? "someone"})` : "");
  item.appendChild(name);
  const replace = document.createElement("button");
  replace.type = "button";
  replace.className = "secondary";
  replace.textContent = "Replace";
  replace.title = "A new picture, same name: messages and reactions with it show the new one";
  replace.addEventListener("click", () => {
    replacingEmoji = emoji;
    emojiStatus.textContent = "";
    emojiInput.click();  // the same picker and editor as for a new emoji
  });
  item.appendChild(replace);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    const response = await fetch("/custom-emoji/" + emoji.id, { method: "DELETE" });
    if (!response.ok) showStatus(emojiStatus, "Couldn't delete it.", "error");
    // On success, the server sends everyone the new list, which redraws this.
  });
  item.appendChild(remove);
  return item;
}

// Our own custom emoji, each with a Delete button, and "3/12". Admins also see everyone else's.
function renderMyEmoji() {
  const mine = customEmoji.filter((emoji) => emoji.owner_id === myId);
  emojiCount.textContent = `Your emoji: ${mine.length}/${MAX_CUSTOM_EMOJI}. Everyone can react with them.`;
  myEmojiList.replaceChildren();
  for (const emoji of mine) myEmojiList.appendChild(makeEmojiItem(emoji, false));

  const others = customEmoji.filter((emoji) => emoji.owner_id !== myId);
  if (amAdmin() && others.length) {
    const heading = document.createElement("p");
    heading.className = "admin-heading";
    heading.textContent = "Everyone else's emoji (as an admin you can replace or delete them):";
    myEmojiList.appendChild(heading);
    for (const emoji of others) myEmojiList.appendChild(makeEmojiItem(emoji, true));
  }
  addEmojiButton.disabled = mine.length >= MAX_CUSTOM_EMOJI;
}

addEmojiButton.addEventListener("click", () => {
  // Check the name first (the server checks again), so nobody crops a picture for nothing.
  const name = emojiNameInput.value.trim();
  if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) {
    showStatus(emojiStatus, "Names are 2–32 letters, digits or _.", "error");
    return;
  }
  if (customEmoji.some((emoji) => emoji.name.toLowerCase() === name.toLowerCase())) {
    showStatus(emojiStatus, `There's already an emoji called :${name}:.`, "error");
    return;
  }
  pendingEmojiName = name;
  replacingEmoji = null;  // a new one, not a replacement
  emojiStatus.textContent = "";
  emojiInput.click();
});

emojiInput.addEventListener("change", async () => {
  const file = emojiInput.files[0];
  emojiInput.value = "";
  if (!file) return;
  if (file.type === "image/gif" && file.size > 10 * 1024 * 1024) {
    showStatus(emojiStatus, "GIFs can be at most 10 MB.", "error");
    return;
  }
  try {
    openCropper(await loadPicture(file), "emoji", file);
  } catch {
    showStatus(emojiStatus, "Couldn't read that picture. Try a PNG or JPEG.", "error");
  }
});

// Where messages about an upload go: the Emoji section's line for emoji, the Profile one otherwise.
function statusLineFor(kind) {
  return kind === "emoji" ? emojiStatus : profileStatusLine;
}

// Upload a finished picture: a profile picture or banner (to /settings/...), or a custom emoji
// (to /custom-emoji, with its name). `params` is extra information for the address,
// like {left: 0, top: 0, width: 200, height: 200} for a GIF's crop.
async function uploadPicture(kind, picture, params = {}) {
  const statusLine = statusLineFor(kind);
  // A new emoji needs its name; a replaced one keeps its own (it's in the address instead).
  if (kind === "emoji" && !replacingEmoji) params = { name: pendingEmojiName, ...params };  // ...params: copy in the rest
  const query = new URLSearchParams(params).toString();  // "name=pog&left=0&..."
  let address = "/settings/" + kind;
  if (kind === "emoji") address = replacingEmoji ? `/custom-emoji/${replacingEmoji.id}/picture` : "/custom-emoji";
  const url = address + (query ? "?" + query : "");

  showStatus(statusLine, "Uploading…", "success");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": picture.type },
    body: picture,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    showStatus(statusLine, typeof error.detail === "string" ? error.detail : "Upload failed.", "error");
    return;
  }
  // The server sends everyone (us too) an updated list (users, or custom emoji), which
  // redraws the pictures, including the ones in Settings.
  if (kind === "emoji" && replacingEmoji) {
    showStatus(statusLine, `New picture for :${replacingEmoji.name}:`, "success");
  } else if (kind === "emoji") {
    showStatus(statusLine, `Added :${pendingEmojiName}:`, "success");
    emojiNameInput.value = "";
  } else {
    showStatus(statusLine, kind === "banner" ? "Banner changed." : "Picture changed.", "success");
  }
}

// Load a picture file so it can be drawn. Fails if the browser can't read it.
async function loadPicture(file) {
  const url = URL.createObjectURL(file);  // a temporary local address for the file
  const img = new Image();
  img.src = url;
  try {
    await img.decode();  // wait until the browser has loaded the picture
  } finally {
    URL.revokeObjectURL(url);  // once loaded, the picture stays usable without it
  }
  return img;
}

// Cut a rectangle out of the original picture (left, top, width, height: in the picture's
// own pixels) and shrink it to saveWidth x saveHeight on a <canvas>, then save that as a
// small image file. A phone photo of several MB becomes a few KB.
function rectangleToFile(img, left, top, width, height, saveWidth, saveHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = saveWidth;
  canvas.height = saveHeight;
  // drawImage(picture, cut out x, y, width, height, ..., draw at x, y, width, height)
  canvas.getContext("2d").drawImage(img, left, top, width, height, 0, 0, saveWidth, saveHeight);

  // toBlob turns the canvas into an image file. It reports back through a callback
  // instead of returning, so we wrap it in a Promise to be able to "await" it.
  // (Browsers that can't make WebP give us a PNG instead; the server accepts both.)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject()), "image/webp", 0.85);
  });
}

// ---------- Picture editor (move and zoom before uploading) ----------
//
// The preview canvas is a frame of `cropShape.width` x `cropShape.height` pixels: a circle
// for profile pictures, a wide rectangle for banners. Three numbers describe where the picture
// is: `cropScale` (how much it's enlarged: canvas pixels per picture pixel) and `cropX`, `cropY`
// (where its top-left corner is, in canvas pixels; 0 or negative).

const CROP_SHAPES = {
  avatar: { title: "Edit picture", width: 256, height: 256, round: true, saveWidth: 256, saveHeight: 256 },
  // Banners are shown wide, so they're saved bigger than the frame to stay sharp.
  banner: { title: "Edit banner", width: 300, height: 100, round: false, saveWidth: 960, saveHeight: 320 },
  emoji: { title: "Edit emoji", width: 160, height: 160, round: false, saveWidth: 128, saveHeight: 128 },
};
const MAX_ZOOM = 4;
let cropKind = "avatar";
let cropShape = CROP_SHAPES.avatar;
let cropImage = null;
let cropFile = null;   // the original file, if it's a GIF (sent whole, to keep the animation)
let cropMinScale = 1;  // the zoom where the picture just covers the whole frame
let cropScale = 1;
let cropX = 0;
let cropY = 0;

function openCropper(img, kind, file) {
  cropKind = kind;
  // A canvas only holds one still frame, so a GIF is shown as an <img> under the (empty) canvas
  // instead: the browser animates that by itself. Save sends the original file, not the canvas.
  cropFile = file.type === "image/gif" ? file : null;
  cropGif.hidden = !cropFile;
  if (cropFile) cropGif.src = URL.createObjectURL(cropFile);  // let go of in the "close" handler
  cropShape = CROP_SHAPES[kind];
  cropTitle.textContent = cropShape.title;

  // Size the canvas for this shape (its own pixels), and the frame around it: how big it's
  // shown on the page. The canvas fills the frame.
  cropCanvas.width = cropShape.width;
  cropCanvas.height = cropShape.height;
  cropFrame.style.width = `min(${cropShape.width}px, 100%)`;
  cropFrame.style.aspectRatio = `${cropShape.width} / ${cropShape.height}`;
  cropFrame.classList.toggle("round", cropShape.round);

  cropImage = img;
  // The smallest zoom where the picture still covers the whole frame: enough to fill the
  // width AND the height, so the larger of the two. (For a square frame, that's simply
  // "the shorter side fills it".) Start there, centred.
  cropMinScale = Math.max(cropShape.width / img.naturalWidth, cropShape.height / img.naturalHeight);
  cropScale = cropMinScale;
  cropX = (cropShape.width - img.naturalWidth * cropScale) / 2;
  cropY = (cropShape.height - img.naturalHeight * cropScale) / 2;
  cropZoom.value = 1;
  drawCrop();
  cropperDialog.showModal();
}

// Keep the picture covering the whole frame: its left edge may not move right of the
// frame's left edge (x <= 0), and its right edge may not move left of the frame's right
// edge (x >= frame width - picture width). The same for top and bottom.
function clampCrop() {
  const width = cropImage.naturalWidth * cropScale;
  const height = cropImage.naturalHeight * cropScale;
  cropX = Math.min(0, Math.max(cropShape.width - width, cropX));
  cropY = Math.min(0, Math.max(cropShape.height - height, cropY));
}

function drawCrop() {
  clampCrop();
  const context = cropCanvas.getContext("2d");
  context.clearRect(0, 0, cropShape.width, cropShape.height);
  if (cropFile) {
    // A GIF: move the <img> instead of painting. The same numbers, as percentages of the frame,
    // so it also lines up when the frame is shown smaller than its own pixels (phones).
    cropGif.style.left = (cropX / cropShape.width) * 100 + "%";
    cropGif.style.top = (cropY / cropShape.height) * 100 + "%";
    cropGif.style.width = ((cropImage.naturalWidth * cropScale) / cropShape.width) * 100 + "%";
    return;
  }
  context.drawImage(
    cropImage, cropX, cropY, cropImage.naturalWidth * cropScale, cropImage.naturalHeight * cropScale
  );
}

// Zoom to `factor` times the minimum (1 to MAX_ZOOM), keeping the middle of the view in place:
// find which point of the picture is in the middle now, then put that same point
// back in the middle at the new zoom.
function setZoom(factor) {
  factor = Math.min(MAX_ZOOM, Math.max(1, factor));
  const middleX = (cropShape.width / 2 - cropX) / cropScale;  // in the picture's own pixels
  const middleY = (cropShape.height / 2 - cropY) / cropScale;
  cropScale = cropMinScale * factor;
  cropX = cropShape.width / 2 - middleX * cropScale;
  cropY = cropShape.height / 2 - middleY * cropScale;
  cropZoom.value = factor;
  drawCrop();
}

cropZoom.addEventListener("input", () => setZoom(Number(cropZoom.value)));

// The scroll wheel zooms too. { passive: false } is needed to be allowed to call
// preventDefault() (which stops the wheel from also scrolling the page).
cropCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const current = cropScale / cropMinScale;
  setZoom(event.deltaY < 0 ? current * 1.1 : current / 1.1);  // deltaY < 0: wheel turned up
}, { passive: false });

// Dragging, with pointer events: one set of events for mouse, finger and pen alike.
let dragFrom = null;  // where the pointer was last time, while dragging

cropCanvas.addEventListener("pointerdown", (event) => {
  // Keep receiving this pointer's moves even if it slides off the canvas mid-drag.
  cropCanvas.setPointerCapture(event.pointerId);
  dragFrom = { x: event.clientX, y: event.clientY };
});

cropCanvas.addEventListener("pointermove", (event) => {
  if (!dragFrom) return;
  // The pointer moves in screen pixels, but the canvas may be shown smaller than its own
  // pixels (on a phone), so convert: canvas pixels per screen pixel.
  const ratio = cropShape.width / cropCanvas.getBoundingClientRect().width;
  cropX += (event.clientX - dragFrom.x) * ratio;
  cropY += (event.clientY - dragFrom.y) * ratio;
  dragFrom = { x: event.clientX, y: event.clientY };
  drawCrop();
});

function stopDragging() {
  dragFrom = null;
}
cropCanvas.addEventListener("pointerup", stopDragging);
cropCanvas.addEventListener("pointercancel", stopDragging);  // e.g. the phone took over the touch

cropCancel.addEventListener("click", () => cropperDialog.close());

// However it closed (Cancel, Save, Esc): let go of the GIF's temporary address and its memory.
cropperDialog.addEventListener("close", () => {
  if (cropGif.src) {
    URL.revokeObjectURL(cropGif.src);
    cropGif.removeAttribute("src");
  }
});

cropSave.addEventListener("click", async () => {
  // Which part of the original picture is inside the frame? Turn canvas pixels back into
  // picture pixels: the frame's corner (0, 0) is at -cropX / cropScale in the picture,
  // and the frame's width in canvas pixels covers width / cropScale picture pixels.
  const left = -cropX / cropScale;
  const top = -cropY / cropScale;
  const width = cropShape.width / cropScale;
  const height = cropShape.height / cropScale;
  cropperDialog.close();

  if (cropFile) {
    // A GIF: send the whole file, with the rectangle (in whole pixels) in the address.
    // The server cuts that rectangle out of every frame, keeping the animation.
    // Math.floor/round give whole numbers; Math.min keeps the rectangle inside the picture.
    const box = {
      left: Math.floor(left),
      top: Math.floor(top),
      width: Math.min(Math.round(width), cropImage.naturalWidth - Math.floor(left)),
      height: Math.min(Math.round(height), cropImage.naturalHeight - Math.floor(top)),
    };
    await uploadPicture(cropKind, cropFile, box);
    return;
  }

  let picture;
  try {
    picture = await rectangleToFile(cropImage, left, top, width, height, cropShape.saveWidth, cropShape.saveHeight);
  } catch {
    showStatus(statusLineFor(cropKind), "Couldn't save that picture.", "error");
    return;
  }
  await uploadPicture(cropKind, picture);
});

function showStatus(element, text, kind) {
  element.className = "status " + kind;  // "error" (red) or "success" (green)
  element.textContent = text;
}

// Send JSON to the server. Returns {ok: true, data} or {ok: false, error: "message to show"}.
async function postJson(url, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, data: result };
  return { ok: false, error: typeof result.detail === "string" ? result.detail : "Something went wrong." };
}

usernameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await postJson("/settings/username", {
    username: newUsernameInput.value,
    password: usernamePasswordInput.value,
  });
  if (!result.ok) {
    showStatus(usernameStatus, result.error, "error");
    return;
  }
  currentUsername.textContent = result.data.username;
  usernameForm.reset();
  showStatus(usernameStatus, "Username changed.", "success");
});

emailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await postJson("/settings/email", {
    email: newEmailInput.value,
    password: emailPasswordInput.value,
  });
  if (!result.ok) {
    showStatus(emailStatus, result.error, "error");
    return;
  }
  currentEmail.textContent = result.data.email;
  emailForm.reset();
  showStatus(emailStatus, "Email saved.", "success");
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (newPasswordInput.value !== newPasswordAgainInput.value) {
    showStatus(passwordStatus, "The two new passwords don't match.", "error");
    return;
  }
  const result = await postJson("/settings/password", {
    current_password: currentPasswordInput.value,
    new_password: newPasswordInput.value,
  });
  if (!result.ok) {
    showStatus(passwordStatus, result.error, "error");
    return;
  }
  passwordForm.reset();
  showStatus(passwordStatus, "Password changed. Your other devices have been logged out.", "success");
});

// ---------- Settings: bugs & ideas ----------

const feedbackForm = document.getElementById("feedback-form");
const feedbackText = document.getElementById("feedback-text");
const feedbackStatus = document.getElementById("feedback-status");
const feedbackSendButton = feedbackForm.querySelector("button");

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  // The chosen radio button: ":checked" finds the one that's ticked.
  const kind = feedbackForm.querySelector('input[name="feedback-kind"]:checked').value;
  feedbackSendButton.disabled = true;  // no second copy from a double click
  const result = await postJson("/feedback", { kind, text: feedbackText.value, app: inDesktopApp });
  feedbackSendButton.disabled = false;
  if (!result.ok) {
    showStatus(feedbackStatus, result.error, "error");
    return;
  }
  feedbackForm.reset();  // empties the text (and goes back to "bug")
  showStatus(feedbackStatus, kind === "bug" ? "Thanks! The bug report is sent." : "Thanks! Your idea is sent.", "success");
});

// ---------- Settings: the inbox (admins only) ----------
// Every bug report and idea, newest first. Loaded from the server each time Settings opens;
// the filter buttons only choose which of the loaded ones to show.

const inboxTab = document.getElementById("inbox-tab");
const inboxCount = document.getElementById("inbox-count");
const inboxFilterButtons = document.querySelectorAll("#inbox-filters button");
const inboxEmpty = document.getElementById("inbox-empty");
const inboxList = document.getElementById("inbox-list");
let inboxReports = [];     // [{id, user_id, kind, text, user_agent, created_at, done}, ...]
let inboxFilter = "open";  // "open", "done" or "all"

// Called when Settings opens. For everyone else the tab stays hidden (and the server would
// refuse them anyway).
async function loadInbox() {
  inboxTab.hidden = !amAdmin();
  if (inboxTab.hidden) {
    if (settingsPage === "inbox") showSettingsPage("account");  // (no longer an admin)
    return;
  }
  const response = await fetch("/feedback");
  if (!response.ok) {
    inboxEmpty.hidden = false;
    inboxEmpty.textContent = "Couldn't load the reports.";
    return;
  }
  inboxReports = await response.json();
  renderInbox();
}

// "Chrome on Android", "Windows app", ... from the User-Agent text the browser sent. These are
// rough guesses by looking for known words, which is all a User-Agent allows. The order matters:
// Edge's says "Chrome" and "Safari" too, and Chrome's says "Safari".
function describeDevice(userAgent) {
  if (!userAgent) return "unknown device";
  if (userAgent.startsWith("ChatApp Windows app")) return "Windows app";
  let browser = "a browser";
  if (userAgent.includes("Edg/")) browser = "Edge";
  else if (userAgent.includes("OPR/")) browser = "Opera";
  else if (userAgent.includes("Firefox/") || userAgent.includes("FxiOS/")) browser = "Firefox";
  else if (userAgent.includes("Chrome/") || userAgent.includes("CriOS/")) browser = "Chrome";
  else if (userAgent.includes("Safari/")) browser = "Safari";
  let system = "";
  if (userAgent.includes("Android")) system = "Android";
  else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) system = "iPhone/iPad";
  else if (userAgent.includes("Windows")) system = "Windows";
  else if (userAgent.includes("Mac OS X")) system = "Mac";
  else if (userAgent.includes("Linux")) system = "Linux";
  return system ? `${browser} on ${system}` : browser;
}

// One report as a card: who and when, the text, where it was sent from, and Mark done / Reopen.
function makeInboxItem(report) {
  const item = document.createElement("article");
  item.className = "inbox-item" + (report.done ? " done" : "");

  const head = document.createElement("div");
  head.className = "inbox-head";
  const name = people.get(report.user_id)?.name ?? "someone";
  head.appendChild(makeAvatar(report.user_id, name, "small"));
  const nameElement = document.createElement("strong");
  nameElement.textContent = name;
  head.appendChild(nameElement);
  const kind = document.createElement("span");
  kind.className = "inbox-kind " + report.kind;  // "bug" or "idea": its own colour (chat.css)
  kind.textContent = report.kind === "bug" ? "🐛 Bug" : "💡 Idea";
  head.appendChild(kind);
  const time = document.createElement("time");
  const sent = new Date(report.created_at);
  time.textContent = dayName(sent) + " at " + formatClock(sent);  // "Yesterday at 14:03"
  time.title = sent.toLocaleString();
  head.appendChild(time);
  item.appendChild(head);

  // textContent, never innerHTML: this is text someone typed. The CSS keeps its line breaks.
  const text = document.createElement("p");
  text.className = "inbox-text";
  text.textContent = report.text;
  item.appendChild(text);

  const foot = document.createElement("div");
  foot.className = "inbox-foot";
  const device = document.createElement("span");
  device.textContent = `#${report.id} · from ${describeDevice(report.user_agent)}`;
  device.title = report.user_agent || "";  // the whole User-Agent, when hovering it
  foot.appendChild(device);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = report.done ? "Reopen" : "Mark done";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const result = await postJson(`/feedback/${report.id}/done`, { done: !report.done });
    if (!result.ok) {
      button.disabled = false;
      device.textContent = result.error;
      return;
    }
    report.done = !report.done;  // the same object as in inboxReports, so the list knows too
    renderInbox();
  });
  foot.appendChild(button);
  item.appendChild(foot);
  return item;
}

function renderInbox() {
  const openCount = inboxReports.filter((report) => !report.done).length;
  inboxCount.textContent = openCount ? `(${openCount})` : "";
  const shown = inboxReports.filter((report) =>
    inboxFilter === "all" || (inboxFilter === "done" ? report.done : !report.done));
  inboxList.replaceChildren(...shown.map(makeInboxItem));  // "...": each card as its own argument
  inboxEmpty.hidden = shown.length > 0;
  inboxEmpty.textContent = inboxFilter === "open" ? "Nothing open. 🎉" : "Nothing here yet.";
}

for (const button of inboxFilterButtons) {
  button.addEventListener("click", () => {
    inboxFilter = button.dataset.filter;
    for (const other of inboxFilterButtons) other.setAttribute("aria-pressed", other === button ? "true" : "false");
    renderInbox();
  });
}
