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
  renderMyEmoji();
  showNotificationSettings();  // (the browser's permission may have changed since)
  settingsDialog.showModal();

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

// One custom emoji with its name (and, for others' emoji, whose it is) and a Delete button.
function makeEmojiItem(emoji, showOwner) {
  const item = document.createElement("div");
  item.className = "my-emoji-item";
  item.appendChild(makeEmojiElement("custom:" + emoji.id));
  const name = document.createElement("span");
  name.textContent = ":" + emoji.name + ":" + (showOwner ? ` (${people.get(emoji.owner_id)?.name ?? "someone"})` : "");
  item.appendChild(name);
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
    heading.textContent = "Everyone else's emoji (you can delete them as an admin):";
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
  if (kind === "emoji") params = { name: pendingEmojiName, ...params };  // ...params: copy in the rest
  const query = new URLSearchParams(params).toString();  // "name=pog&left=0&..."
  const url = (kind === "emoji" ? "/custom-emoji" : "/settings/" + kind) + (query ? "?" + query : "");

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
  if (kind === "emoji") {
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
  // A canvas only holds one still frame, so for a GIF the preview shows its first frame,
  // and Save sends the original file instead of the canvas.
  cropFile = file.type === "image/gif" ? file : null;
  cropShape = CROP_SHAPES[kind];
  cropTitle.textContent = cropShape.title;

  // Size the canvas for this shape: its own pixels, and how big it's shown on the page.
  cropCanvas.width = cropShape.width;
  cropCanvas.height = cropShape.height;
  cropCanvas.style.width = `min(${cropShape.width}px, 100%)`;
  cropCanvas.style.aspectRatio = `${cropShape.width} / ${cropShape.height}`;
  cropCanvas.classList.toggle("round", cropShape.round);

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
