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
  showAdmin();  // (admins only: the Admin tab, its inbox, channels, roles and invites fetched fresh)
  showNotificationSettings();  // (the browser's permission may have changed since)
  showPushSetting();  // (and whether this device gets push notifications)
  showAppSettings();  // (and, in the app, whether it starts with Windows)
  settingsDialog.showModal();
  showSettingsPage(settingsPage);  // the tab from last time, in sight (on a phone) and from the top

  // Ask the server for our current details, to show them.
  const response = await fetch("/me");
  if (response.ok) {
    const me = await response.json();  // {username, email, avatar, status, bio}
    currentUsername.textContent = me.username;
    currentEmail.textContent = me.email || "none yet";
    showPendingEmail(me.pending_email);
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
  if (name === "appearance") showAppearanceSettings();
  if (name === "voice" && settingsDialog.open) unlockDevices();  // (voice-settings.js: the devices' names)
}

for (const tab of settingsTabs) {
  tab.addEventListener("click", () => showSettingsPage(tab.dataset.tab));
}
showSettingsPage(settingsPage);  // at the start: hide every page but the first

// ---------- Settings: App behaviour (only in the Windows app) ----------
//
// Whether Windows starts the app when you log in. The app does that itself (main.rs: get_autostart and
// set_autostart, with Tauri's autostart plugin); the page only asks it. A browser has no
// __TAURI_INTERNALS__ (inDesktopApp, notifications.js), and an app from before 0.1.16 doesn't know
// these commands (invoke fails): in both, the tab stays hidden.

const appTab = document.getElementById("app-tab");
const autostartBox = document.getElementById("app-autostart");
const autostartHelp = document.getElementById("app-autostart-help");

// Asked again every time Settings opens: it may have been switched off in Task Manager meanwhile.
async function showAppSettings() {
  if (!inDesktopApp) return;
  try {
    autostartBox.checked = await window.__TAURI_INTERNALS__.invoke("get_autostart");
    appTab.hidden = false;
  } catch {
    appTab.hidden = true;  // an older app version
  }
}

autostartBox.addEventListener("change", async () => {
  try {
    await window.__TAURI_INTERNALS__.invoke("set_autostart", { on: autostartBox.checked });
  } catch (error) {
    autostartBox.checked = !autostartBox.checked;  // it didn't change: show how it really is
    autostartHelp.textContent = `Couldn't change it (${error}).`;
  }
});
showAppSettings();

// ---------- Settings: Activity (in App behaviour, only in the Windows app) ----------
//
// The app looks at what's open on the PC (activity.rs: a game, the song in Spotify, a program you
// added) and calls activityFromApp each time that changes; we pass it on to the server, which shows
// it to everyone under our name ("users": activity). Kept in this app's storage, like the voice
// settings: on by default, your programs as [["code.exe", "Visual Studio Code"], ...].

const activitySettingsBox = document.getElementById("activity-settings");
const activityShareBox = document.getElementById("activity-share");
const activityProgramsList = document.getElementById("activity-programs");
const activityAddButton = document.getElementById("activity-add");
const activityChoices = document.getElementById("activity-choices");

const activitySettings = { share: true, programs: [] };
try {
  Object.assign(activitySettings, JSON.parse(localStorage.getItem("activitySettings")) || {});
} catch {}

let myActivity = null;  // what the app saw last (null: nothing), sent again after a reconnect (core.js)

// Called by the app (window.eval in activity.rs).
function activityFromApp(activity) {
  myActivity = activity;
  sendActivity();
}

function sendActivity() {
  if (inDesktopApp && socket) sendToServer({ type: "activity", activity: myActivity });
}

// Save, and tell the app (at every load too: it starts with sharing off until we do). An app from
// before 0.1.20 doesn't know the command: then the section stays hidden.
function applyActivitySettings() {
  try {
    localStorage.setItem("activitySettings", JSON.stringify(activitySettings));
  } catch {}
  if (!inDesktopApp) return;
  window.__TAURI_INTERNALS__.invoke("set_activity_settings", activitySettings)
    .then(() => { activitySettingsBox.hidden = false; })
    .catch(() => {});
}

function renderActivitySettings() {
  activityShareBox.checked = activitySettings.share;
  activityProgramsList.replaceChildren(...activitySettings.programs.map(([file, name]) => {
    const row = document.createElement("div");
    row.className = "activity-program";
    const label = document.createElement("span");
    label.textContent = name;
    label.title = file;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      activitySettings.programs = activitySettings.programs.filter(([other]) => other !== file);
      applyActivitySettings();
      renderActivitySettings();
    });
    row.append(label, remove);
    return row;
  }));
}

activityShareBox.addEventListener("change", () => {
  activitySettings.share = activityShareBox.checked;
  applyActivitySettings();
});

// "Add a program": the app lists what's open right now; clicking one adds it (or click Add again to close).
activityAddButton.addEventListener("click", async () => {
  if (!activityChoices.hidden) {
    activityChoices.hidden = true;
    return;
  }
  let programs = [];
  try {
    programs = await window.__TAURI_INTERNALS__.invoke("list_programs");
  } catch {}
  const chosen = new Set(activitySettings.programs.map(([file]) => file));
  const buttons = programs.filter(([file]) => !chosen.has(file)).map(([file, name]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.title = file;
    button.addEventListener("click", () => {
      activitySettings.programs.push([file, name]);
      activityChoices.hidden = true;
      applyActivitySettings();
      renderActivitySettings();
    });
    return button;
  });
  if (buttons.length === 0) {
    const empty = document.createElement("p");
    empty.className = "settings-help";
    empty.textContent = "Open the program first, then press Add a program again.";
    buttons.push(empty);
  }
  activityChoices.replaceChildren(...buttons);
  activityChoices.hidden = false;
});

renderActivitySettings();
applyActivitySettings();

// ---------- Settings: Appearance ----------
//
// Theme, colours, font and text size, kept with the account. appearance.js does the work:
// applyAppearance shows settings on the whole page, saveAppearance also saves them. Every change
// here shows at once; sliders and colour pickers save when let go ("change"), not while they're
// moving ("input"), so the server gets one save instead of dozens a second.

const themeSwatches = document.querySelectorAll(".theme-swatch");
const colourInputs = document.querySelectorAll(".colour-pickers input");
const coloursReset = document.getElementById("colours-reset");
const fontRadios = document.querySelectorAll('input[name="font"]');
const fontSizeSlider = document.getElementById("font-size");
const fontSizeValue = document.getElementById("font-size-value");
const appearanceStatus = document.getElementById("appearance-status");
const scaleRow = document.getElementById("scale-row");
const scaleSlider = document.getElementById("scale");
const scaleValue = document.getElementById("scale-value");

// Scale: a slider in the app (canZoom, appearance.js), the note about Ctrl + in a browser.
scaleRow.hidden = !canZoom;
document.getElementById("scale-note").hidden = canZoom;

// Each font's name written in that font (its label is the radio button's parent).
for (const radio of fontRadios) {
  radio.parentElement.style.fontFamily = APPEARANCE_FONTS[radio.value];
}

// Set the controls to what's showing now (`appearance`, in appearance.js).
function showAppearanceSettings() {
  for (const swatch of themeSwatches) {
    swatch.setAttribute("aria-pressed", swatch.dataset.theme === appearance.theme ? "true" : "false");
  }
  // Each picker: the colour in use now, picked or the theme's, as the browser works it out.
  const styles = getComputedStyle(document.documentElement);
  for (const input of colourInputs) {
    input.value = styles.getPropertyValue("--" + input.dataset.colour).trim();
  }
  for (const radio of fontRadios) radio.checked = radio.value === appearance.font;
  fontSizeSlider.value = appearance.font_size;
  fontSizeValue.textContent = appearance.font_size + "px";
  scaleSlider.value = appearance.scale;
  scaleValue.textContent = appearance.scale + "%";
}

// Change some settings (the rest stay as they are): shown at once, then saved.
async function changeAppearance(changes) {
  const saving = saveAppearance({ ...appearance, ...changes });  // (shows them before it saves)
  showAppearanceSettings();
  appearanceStatus.textContent = (await saving) ? "" : "Couldn't save that. Is the connection lost?";
}

// A theme starts from its own colours: picked ones would clash (dark text on a dark background).
for (const swatch of themeSwatches) {
  swatch.addEventListener("click", () => changeAppearance({ theme: swatch.dataset.theme, colours: {} }));
}

for (const input of colourInputs) {
  // The colours with this one changed. (`[input.dataset.colour]`: a key whose name is worked out.)
  const withThisColour = () => ({ ...appearance.colours, [input.dataset.colour]: input.value });
  input.addEventListener("input", () => applyAppearance({ ...appearance, colours: withThisColour() }));
  input.addEventListener("change", () => changeAppearance({ colours: withThisColour() }));
}
coloursReset.addEventListener("click", () => changeAppearance({ colours: {} }));

for (const radio of fontRadios) {
  radio.addEventListener("change", () => changeAppearance({ font: radio.value }));
}

fontSizeSlider.addEventListener("input", () => {
  applyAppearance({ ...appearance, font_size: Number(fontSizeSlider.value) });
  fontSizeValue.textContent = fontSizeSlider.value + "px";
});
fontSizeSlider.addEventListener("change", () => changeAppearance({ font_size: Number(fontSizeSlider.value) }));

// The scale only changes once let go: zooming while dragging would move the slider away under
// the mouse (the zoom makes the slider itself bigger or smaller). Meanwhile only the number moves.
scaleSlider.addEventListener("input", () => {
  scaleValue.textContent = scaleSlider.value + "%";
});
scaleSlider.addEventListener("change", () => changeAppearance({ scale: Number(scaleSlider.value) }));

// ---------- Settings: What's new ----------
//
// Written by hand in static/changelog.json, in two parts:
//   "changes":  what changed when, newest day first: [{"date": "2026-10-12", "items": [...]}]
//   "features": everything the chat can do, by topic: [{"topic": "💬 Messages", "items": [...]}]
// This browser remembers how many lines of "changes" it has shown (localStorage
// "changelogSeenCount"). More lines than that puts a red dot on ⚙️ and on the tab; editing a
// line, or "features", doesn't. (Removing one line and adding one in the same go isn't noticed.)

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

// How many lines "changes" has, over all its days.
function countChangeLines() {
  let count = 0;
  for (const entry of changelog.changes) count += entry.items.length;
  return count;
}

localStorage.removeItem("changelogSeen");  // the old way (a fingerprint of all the text), no longer used

function updateChangelogDots() {
  // Number(...) turns the saved text into a number; nothing saved yet (null) becomes 0.
  const unseen = countChangeLines() > Number(localStorage.getItem("changelogSeenCount"));
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
  localStorage.setItem("changelogSeenCount", String(countChangeLines()));
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
  currentEmail.textContent = result.data.email || "none yet";
  showPendingEmail(result.data.pending);
  emailForm.reset();
  showStatus(emailStatus, result.data.pending
    ? "We sent a link to the new address: your email changes when you click it."
    : "That's already your email.", "success");
});

// A new address waiting for its link (or null: none). It only becomes the account's email once the
// link in the email to it is clicked (/verify, which also tells the old address).
const pendingEmail = document.getElementById("pending-email");

function showPendingEmail(address) {
  pendingEmail.hidden = !address;
  document.getElementById("pending-email-address").textContent = address || "";
}

document.getElementById("pending-resend").addEventListener("click", async () => {
  const result = await postJson("/verify/resend", {});
  if (result.ok) showStatus(emailStatus, "Sent again. Check that inbox, and its spam folder.", "success");
  else showStatus(emailStatus, result.error, "error");
});

document.getElementById("pending-cancel").addEventListener("click", async () => {
  const result = await postJson("/settings/email/cancel", {});
  if (!result.ok) {
    showStatus(emailStatus, result.error, "error");
    return;
  }
  showPendingEmail(null);
  showStatus(emailStatus, "Cancelled: your email stays as it is.", "success");
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

// ---------- Settings: Admin (admins only) ----------
//
// One tab for everything only admins can do. Its page has a row of sub-tabs (Inbox, Channels, Roles,
// Invites), each showing one section; each section's own code follows below. The server checks
// every admin request itself: hiding the tab only keeps it out of everyone else's way.

const adminTab = document.getElementById("admin-tab");
const adminTabs = document.querySelectorAll(".admin-tab");
const adminSections = document.querySelectorAll(".admin-section");
let adminSection = "inbox";  // the sub-tab showing; Settings opens on it again (until a reload)

// Called when Settings opens: the tab for admins only, and everything in it fresh.
function showAdmin() {
  adminTab.hidden = !amAdmin();
  if (adminTab.hidden) {
    if (settingsPage === "admin") showSettingsPage("account");  // (no longer an admin)
    return;
  }
  if (!adminPickersReady) setUpAdminPickers();
  // Admins (making and removing them): the owner's alone.
  document.getElementById("admins-tab").hidden = !amOwner();
  if (!amOwner() && adminSection === "admins") showAdminSection("inbox");
  loadInbox();
  showChannelAdmin();
  showRoleAdmin();
  loadAdminInvites();
  loadBans();
  renderAdmins();
}

function showAdminSection(name) {
  adminSection = name;
  for (const section of adminSections) section.hidden = section.dataset.section !== name;
  for (const tab of adminTabs) tab.classList.toggle("active", tab.dataset.section === name);
}

for (const tab of adminTabs) {
  tab.addEventListener("click", () => showAdminSection(tab.dataset.section));
}
showAdminSection(adminSection);  // at the start: hide every section but the first

// ---------- Settings: Admin → Invites ----------
//
// Everyone's invite links that still work (with × to cancel any of them) and who joined with whose
// link, from /admin/invites. The rows of links are the People page's (people.js, makeInviteRow).

const adminOpenInvites = document.getElementById("admin-open-invites");
const adminJoined = document.getElementById("admin-joined");
const adminInvitesStatus = document.getElementById("admin-invites-status");

async function loadAdminInvites() {
  adminInvitesStatus.textContent = "";
  const response = await fetch("/admin/invites").catch(() => null);
  if (!response?.ok) {
    showStatus(adminInvitesStatus, "Couldn't load the invites.", "error");
    return;
  }
  showAdminInvites(await response.json());
}

// The server's answer: {open: [{code, link, by, expires}], joined: [{user_id, name, invited_by, joined}]}.
function showAdminInvites(data) {
  adminOpenInvites.replaceChildren(
    ...data.open.map((invite) => makeInviteRow(invite, () => adminCancelInvite(invite.code))),
  );
  if (data.open.length === 0) adminOpenInvites.appendChild(makeEmptyNote("No open links."));
  adminJoined.replaceChildren(...data.joined.map(makeJoinedRow));
  if (data.joined.length === 0) adminJoined.appendChild(makeEmptyNote("Nobody has joined with a link yet."));
}

function makeEmptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty-note";
  note.textContent = text;
  return note;
}

// "kari · invited by axel · 14 Oct 2026", with their picture while they still have an account.
function makeJoinedRow(entry) {
  const row = document.createElement("div");
  row.className = "joined-row";
  const person = people.get(entry.user_id);
  if (person) {
    row.appendChild(makePerson(person));
  } else {
    const name = document.createElement("strong");
    name.textContent = entry.name ?? "a deleted account";
    row.appendChild(name);
  }
  const details = document.createElement("span");
  details.className = "joined-details";
  const when = new Date(entry.joined).toLocaleDateString([], { dateStyle: "medium" });
  details.textContent = `invited by ${entry.invited_by ?? "a deleted account"} · ${when}`;
  row.appendChild(details);
  return row;
}

// The rows on the Bans and Admins pages: a person (their picture while they're in the lists, else
// just the name), a line about them, and a button at the end.
function makeAdminPersonRow(userId, name, details, buttonText, onClick) {
  const row = document.createElement("div");
  row.className = "admin-person-row";
  const person = people.get(userId);
  if (person) {
    row.appendChild(makePerson(person));
  } else {
    const strong = document.createElement("strong");
    strong.textContent = name;  // (banned people aren't in the lists: the server's name for them)
    row.appendChild(strong);
  }
  const line = document.createElement("span");
  line.className = "joined-details";
  line.textContent = details;
  row.appendChild(line);
  if (buttonText) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = buttonText;
    button.addEventListener("click", onClick);
    row.appendChild(button);
  }
  return row;
}

async function adminCancelInvite(code) {
  adminInvitesStatus.textContent = "";
  const result = await postJson(`/admin/invites/${encodeURIComponent(code)}/cancel`, {})
    .catch(() => ({ ok: false, error: "No connection. Try again in a moment." }));
  if (result.ok) showAdminInvites(result.data);
  else showStatus(adminInvitesStatus, result.error, "error");
}

// ---------- Settings: Admin → Bans ----------
//
// Everyone banned right now (from /admin/bans), with Unban, and a search box to ban someone, which
// opens the ban popup (people.js, "Banning").

const banList = document.getElementById("ban-list");
const banStatus = document.getElementById("ban-status");
const banPicker = document.getElementById("ban-picker");

async function loadBans() {
  banStatus.textContent = "";
  const response = await fetch("/admin/bans").catch(() => null);
  if (!response?.ok) {
    showStatus(banStatus, "Couldn't load the bans.", "error");
    return;
  }
  showBans(await response.json());
}

// The server's answer: {bans: [{user_id, name, by, at, until (null = for good), reason}]}.
function showBans(data) {
  const day = (iso) => new Date(iso).toLocaleDateString([], { dateStyle: "medium" });
  banList.replaceChildren(...data.bans.map((ban) => {
    const details = [
      `by ${ban.by ?? "someone"} on ${day(ban.at)}`,
      ban.until ? `until ${day(ban.until)}` : "for good",
      ban.reason ? `"${ban.reason}"` : "",  // (as text: textContent in makeAdminPersonRow)
    ].filter(Boolean).join(" · ");
    return makeAdminPersonRow(ban.user_id, ban.name, details, "Unban", () => unbanUser(ban));
  }));
  if (data.bans.length === 0) banList.appendChild(makeEmptyNote("Nobody is banned."));
}

async function unbanUser(ban) {
  if (!confirm(`Unban ${ban.name}? They can log in again straight away.`)) return;
  const result = await postJson("/admin/unban", { user_id: ban.user_id })
    .catch(() => ({ ok: false, error: "No connection. Try again in a moment." }));
  if (result.ok) showBans(result.data);
  else showStatus(banStatus, result.error, "error");
}


// ---------- Settings: Admin → Admins (the owner only) ----------
//
// Everyone who's an admin, with Remove admin (not for the owner), and a search box to make someone
// one. Drawn from the users list (people), which says who's an admin; the server sends a fresh one
// to everybody after each change, and showUsers (people.js) then draws this again.

const adminList = document.getElementById("admin-list");
const adminsStatus = document.getElementById("admins-status");
const makeAdminPicker = document.getElementById("make-admin-picker");

function renderAdmins() {
  if (!amOwner()) return;
  const admins = [...people.values()].filter((person) => person.admin && !person.bot);
  adminList.replaceChildren(...admins.map((person) => person.owner
    ? makeAdminPersonRow(person.id, person.name, "owner", null)
    : makeAdminPersonRow(person.id, person.name, "admin", "Remove admin", () => setAdmin(person, false))));
}

async function setAdmin(person, admin) {
  const question = admin
    ? `Make ${person.name} an admin? They can edit and delete anyone's messages, manage channels and roles, read the inbox and ban people.`
    : `Remove ${person.name} as an admin?`;
  if (!confirm(question)) return;
  adminsStatus.textContent = "";
  const result = await postJson("/admin/admins", { user_id: person.id, admin })
    .catch(() => ({ ok: false, error: "No connection. Try again in a moment." }));
  if (!result.ok) showStatus(adminsStatus, result.error, "error");
  // (On success the server's new users list redraws the list: see above.)
}

// The two search boxes (Ban someone, Make someone an admin). Set up the first time the Admin tab is
// prepared (showAdmin), not while this file loads: usePersonPicker is in people.js, which loads after
// this file, so it doesn't exist yet at that moment.
let adminPickersReady = false;

function setUpAdminPickers() {
  usePersonPicker(banPicker, document.getElementById("ban-picker-list"), {
    candidates: () => [...people.values()].filter(mayBan),  // (people.js: whom we may ban)
    onPick: (person) => {
      banPicker.value = "";
      openBanDialog(person);
    },
  });
  usePersonPicker(makeAdminPicker, document.getElementById("make-admin-list"), {
    candidates: () => [...people.values()].filter((person) => !person.admin && !person.bot),
    onPick: (person) => {
      makeAdminPicker.value = "";
      setAdmin(person, true);
    },
  });
  adminPickersReady = true;
}

// ---------- Settings: Channels (admins only) ----------
//
// The sidebar's channels and headings: rename, move and delete them, and add new ones. The list
// is the same `channels` the sidebar shows (core.js). Each change goes to the server, which tells
// every page, this one too, with a "channels" message: that redraws the sidebar and this list.

const channelAdminList = document.getElementById("channel-admin-list");
const newChannelForm = document.getElementById("new-channel-form");
const newChannelName = document.getElementById("new-channel-name");
const channelAdminStatus = document.getElementById("channel-admin-status");

// Called when Settings opens, for admins (showAdmin).
function showChannelAdmin() {
  channelAdminStatus.textContent = "";
  renderChannelAdmin();
}

// One row per channel or heading, in the sidebar's order. (map passes each item and its index.)
function renderChannelAdmin() {
  if (!amAdmin()) return;  // (only admins see it; Settings draws it when it opens)
  channelAdminList.replaceChildren(...channels.map(makeChannelAdminItem));
}

// A small grey button. type="button" matters: a button inside a form is a submit button unless
// told otherwise, so ↑ would also "submit" the row (rename it).
function makeChannelAdminButton(icon, label) {
  const button = document.createElement("button");
  button.type = "button";
  setIcon(button, icon);                    // (icons.js)
  button.title = label;                     // shown when hovering
  button.setAttribute("aria-label", label);  // read out by screen readers instead
  return button;
}

// A row: "#" (or an arrow for a heading), the name in a text box, Save (once it's been changed), up, down, delete.
// The row is a form, so Enter in the text box saves too.
function makeChannelAdminItem(item, index) {
  const row = document.createElement("form");
  row.className = "channel-admin-item" + (item.heading ? " heading" : "");

  const mark = document.createElement("span");
  mark.className = "channel-admin-mark";
  if (item.heading) setIcon(mark, "chevron-down");
  else mark.textContent = "#";

  const name = document.createElement("input");
  name.value = item.name;  // (.value, like textContent, is never read as HTML)
  name.maxLength = 30;     // as the server's MAX_CHANNEL_NAME
  name.required = true;    // the browser won't submit it empty
  name.autocomplete = "off";
  name.setAttribute("aria-label", item.heading ? "Heading name" : "Channel name");

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "save";
  save.textContent = "Save";
  save.hidden = true;
  // "input" fires at every key: show Save only when the name is different from the saved one.
  name.addEventListener("input", () => {
    save.hidden = name.value.trim() === item.name;
  });
  row.addEventListener("submit", (event) => {
    event.preventDefault();  // (a form would otherwise load a new page)
    channelAdminRequest(`/channels/${encodeURIComponent(item.key)}/rename`, { name: name.value });
  });

  const up = makeChannelAdminButton("arrow-up", "Move up");
  up.disabled = index === 0;
  up.addEventListener("click", () => moveChannel(index, -1));
  const down = makeChannelAdminButton("arrow-down", "Move down");
  down.disabled = index === channels.length - 1;
  down.addEventListener("click", () => moveChannel(index, 1));
  const remove = makeChannelAdminButton("trash-2", "Delete");
  remove.className = "delete";
  remove.addEventListener("click", () => deleteChannel(item));

  row.append(mark, name, save, up, down, remove);
  if (item.heading) return row;
  // A channel also gets who can see it, under its row.
  const box = document.createElement("div");
  box.append(row, makeChannelAccess(item));
  return box;
}

// Who can see a channel: "Private" ticked = only the ticked roles (and admins, who see everything),
// else everyone (but people with a limited role: Settings → Admin → Roles). Each change is sent at once.
function makeChannelAccess(item) {
  const access = document.createElement("div");
  access.className = "channel-access";
  const ticked = new Set(item.roles);  // the roles that see it now (a Set: has, add, delete)
  const send = (isPrivate) => channelAdminRequest(`/channels/${encodeURIComponent(item.key)}/access`,
    { private: isPrivate, roles: [...ticked] });

  const privateBox = makeCheckbox("Private", item.private, (checked) => send(checked));
  privateBox.title = "Only people with the roles ticked here can see it (admins always can)";
  access.appendChild(privateBox);
  if (!item.private) return access;

  for (const role of roles) {
    const label = makeCheckbox(role.name, ticked.has(role.id), (checked) => {
      if (checked) ticked.add(role.id);
      else ticked.delete(role.id);
      send(true);
    });
    const dot = document.createElement("span");
    dot.className = "role-dot";
    dot.style.background = role.colour;  // (a colour the server checked: "#rrggbb")
    label.insertBefore(dot, label.lastChild);  // before its name
    access.appendChild(label);
  }
  const help = document.createElement("span");
  help.className = "settings-help";
  help.textContent = roles.length === 0
    ? "Only admins see it. Make a role under Roles to let others in."
    : ticked.size === 0 ? "No role ticked: only admins see it." : "";
  access.appendChild(help);
  return access;
}

// <label class="checkbox"><input type="checkbox"> text</label>, calling onChange(checked) when clicked.
function makeCheckbox(text, checked, onChange) {
  const label = document.createElement("label");
  label.className = "checkbox";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  label.append(box, document.createTextNode(text));  // (a text node: a name is never read as HTML)
  return label;
}

// Send a change. The new list comes back through the WebSocket (to every page), so here we only
// show an error if there is one. Returns whether it worked.
async function channelAdminRequest(url, data) {
  const result = await postJson(url, data);
  if (result.ok) channelAdminStatus.textContent = "";
  else showStatus(channelAdminStatus, result.error, "error");
  return result.ok;
}

// Swap a row with the one above (step -1) or below (+1), and send the whole new order.
function moveChannel(index, step) {
  const keys = channels.map((item) => item.key);
  // [a, b] = [b, a] swaps two values in one go.
  [keys[index], keys[index + step]] = [keys[index + step], keys[index]];
  channelAdminRequest("/channels/order", { keys });
}

function deleteChannel(item) {
  const question = item.heading
    ? `Delete the heading "${item.name}"? The channels under it stay.`
    : `Delete #${item.name} and every message and file in it? This can't be undone.`;
  if (!confirm(question)) return;  // the browser's own OK/Cancel box
  channelAdminRequest(`/channels/${encodeURIComponent(item.key)}/delete`, {});
}

// Add channel / Add heading: both submit the form, and event.submitter is the one clicked.
newChannelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const heading = event.submitter?.value === "heading";
  if (await channelAdminRequest("/channels", { name: newChannelName.value, heading })) {
    newChannelForm.reset();
    showStatus(channelAdminStatus, heading ? "Heading added at the bottom." : "Channel added at the bottom.", "success");
  }
});

// ---------- Settings: Roles (admins only) ----------
//
// Each role: its colour (the browser's own colour picker), its name (edit it and press Enter or
// Save), ↑ ↓ and 🗑, and under it the people who have it (× takes it away) with a list to add
// someone. Like Channels, every change goes to the server, which tells every page ("roles", "users"),
// and that draws this list again (core.js).

const roleAdminList = document.getElementById("role-admin-list");
const newRoleForm = document.getElementById("new-role-form");
const newRoleName = document.getElementById("new-role-name");
const newRoleColour = document.getElementById("new-role-colour");
const roleAdminStatus = document.getElementById("role-admin-status");

function showRoleAdmin() {
  roleAdminStatus.textContent = "";
  renderRoleAdmin();
}

function renderRoleAdmin() {
  if (!amAdmin()) return;  // (only admins see it; nothing to draw otherwise)
  roleAdminList.replaceChildren(...roles.map(makeRoleAdminItem));
}

// Send a change and show an error if there is one (the new state comes back to every page).
async function roleAdminRequest(url, data) {
  const result = await postJson(url, data);
  if (result.ok) roleAdminStatus.textContent = "";
  else showStatus(roleAdminStatus, result.error, "error");
  return result.ok;
}

function makeRoleAdminItem(role, index) {
  const box = document.createElement("div");
  box.className = "role-admin-item";

  // The top row, a small form: colour, name, Save (once changed), ↑ ↓ 🗑. Enter in the name saves.
  const row = document.createElement("form");
  row.className = "channel-admin-item";  // (laid out like the Channels page's rows)
  const colour = document.createElement("input");
  colour.type = "color";  // the browser's colour picker; its value is always "#rrggbb"
  colour.value = role.colour;
  colour.setAttribute("aria-label", "Colour");
  const name = document.createElement("input");
  name.value = role.name;
  name.maxLength = 30;
  name.required = true;
  name.autocomplete = "off";
  name.setAttribute("aria-label", "Role name");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "save";
  save.textContent = "Save";
  save.hidden = true;
  name.addEventListener("input", () => { save.hidden = name.value.trim() === role.name; });
  const edit = () => roleAdminRequest(`/roles/${role.id}/edit`, { name: name.value, colour: colour.value });
  row.addEventListener("submit", (event) => {
    event.preventDefault();
    edit();
  });
  colour.addEventListener("change", edit);  // ("change": once a colour is picked, not while dragging)

  const up = makeChannelAdminButton("arrow-up", "Move up");  // (the Channels page's small grey buttons)
  up.disabled = index === 0;
  up.addEventListener("click", () => moveRole(index, -1));
  const down = makeChannelAdminButton("arrow-down", "Move down");
  down.disabled = index === roles.length - 1;
  down.addEventListener("click", () => moveRole(index, 1));
  const remove = makeChannelAdminButton("trash-2", "Delete");
  remove.className = "delete";
  remove.addEventListener("click", () => {
    if (confirm(`Delete the role "${role.name}"? Everyone who has it loses it.`)) {
      roleAdminRequest(`/roles/${role.id}/delete`, {});
    }
  });
  row.append(colour, name, save, up, down, remove);
  box.appendChild(row);

  // Limited: its people only see the private channels it (or another of their roles) opens.
  const limited = makeCheckbox("Limited: sees only the private channels it's ticked in, no other channels and no Lounge",
    role.limited, (checked) => roleAdminRequest(`/roles/${role.id}/limited`, { limited: checked }));
  limited.classList.add("role-limited");
  box.appendChild(limited);

  // Its people, each with × to take the role away, and a list to give it to someone else.
  const members = document.createElement("div");
  members.className = "role-members";
  const everyone = [...people.values()];
  for (const person of everyone.filter((person) => (person.roles ?? []).includes(role.id))) {
    const chip = document.createElement("span");
    chip.className = "role-member";
    const take = makeChannelAdminButton("x", `Take ${role.name} from ${person.name}`);
    take.addEventListener("click", () => roleAdminRequest(`/roles/${role.id}/members`, { user_id: person.id, member: false }));
    chip.append(makeAvatar(person.id, person.name, "tiny"), person.name, take);
    members.appendChild(chip);
  }
  // "+ Add someone": type a name and pick (people.js, usePersonPicker), not a list of everyone.
  const picker = document.createElement("div");
  picker.className = "person-picker role-add";
  const add = document.createElement("input");
  add.placeholder = "+ Add someone";
  add.autocomplete = "off";
  add.setAttribute("aria-label", `Give ${role.name} to someone`);
  const suggestions = document.createElement("div");
  suggestions.hidden = true;
  picker.append(add, suggestions);
  usePersonPicker(add, suggestions, {
    candidates: () => [...people.values()].filter((person) => !(person.roles ?? []).includes(role.id)),
    onPick: (person) => roleAdminRequest(`/roles/${role.id}/members`, { user_id: person.id, member: true }),
  });
  members.appendChild(picker);
  box.appendChild(members);
  return box;
}

// Swap a role with the one above or below, and send the whole new order (like moveChannel).
function moveRole(index, step) {
  const ids = roles.map((role) => role.id);
  [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
  roleAdminRequest("/roles/order", { ids });
}

newRoleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await roleAdminRequest("/roles", { name: newRoleName.value, colour: newRoleColour.value })) {
    newRoleName.value = "";
    showStatus(roleAdminStatus, "Role added at the bottom. Give it to people with \"+ Add someone\".", "success");
  }
});

// ---------- Settings: the inbox (admins only) ----------
// Every bug report and idea, newest first. Loaded from the server each time Settings opens;
// the filter buttons only choose which of the loaded ones to show.

const inboxCount = document.getElementById("inbox-count");
const inboxFilterButtons = document.querySelectorAll("#inbox-filters button");
const inboxEmpty = document.getElementById("inbox-empty");
const inboxList = document.getElementById("inbox-list");
let inboxReports = [];     // [{id, user_id, kind, text, user_agent, created_at, done}, ...]
let inboxFilter = "open";  // "open", "done" or "all"

// Called when Settings opens, for admins (showAdmin).
async function loadInbox() {
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
  if (userAgent.startsWith("ChatApp Android app")) return "Android app";
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
  kind.textContent = report.kind === "bug" ? "Bug" : "Idea";
  setIcon(kind, report.kind === "bug" ? "bug" : "lightbulb");
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
