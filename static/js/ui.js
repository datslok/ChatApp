// The phone drawers, the back button, closing popups with a click outside, the text
// box, emoji autocomplete (typing ":po") and the character limit.
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ---------- Phone drawers ----------
// On phones the sidebar and the online list are drawers. Opening one just adds the
// "open" class; the CSS slides it into view.

function openDrawer(drawer) {
  drawer.classList.add("open");
  drawerBackdrop.hidden = false;
}

function closeDrawers() {
  sidebarElement.classList.remove("open");
  membersElement.classList.remove("open");
  drawerBackdrop.hidden = true;
}

openSidebarButton.addEventListener("click", () => openDrawer(sidebarElement));
openMembersButton.addEventListener("click", () => openDrawer(membersElement));
drawerBackdrop.addEventListener("click", closeDrawers);

// ---------- The back button ----------
// The chat is one page, so by itself "back" would leave it. Instead we add our own steps to
// the browser's history (pushState), and the browser tells us when back is pressed (popstate):
//   - every channel switch is a step: { channel: "memes" }  (added in switchChannel)
//   - an open drawer or popup is one step on top: { channel: "memes", overlay: true }
// Back closes what's open; with nothing open, it goes to the channel before.

function somethingOpen() {
  return sidebarElement.classList.contains("open")
    || membersElement.classList.contains("open")
    || document.querySelector("dialog[open]") !== null;
}

// history.back() takes a moment: until its popstate arrives, don't step back a second time.
let steppingBack = false;

// Make the history match the screen: something open needs an overlay step; nothing open, none.
function syncHistory() {
  if (steppingBack) return;
  const hasOverlayStep = history.state?.overlay === true;
  if (somethingOpen() && !hasOverlayStep) {
    history.pushState({ channel: currentChannel, overlay: true }, "");
  } else if (!somethingOpen() && hasOverlayStep) {
    // Closed with ✕, Esc or the backdrop: remove the step, or the next back would do nothing.
    steppingBack = true;
    history.back();
  }
}

// Check once the click (or key press) has been fully handled, not halfway: tapping "Settings"
// in the drawer closes the drawer *and* opens Settings, which is still "something open".
let syncPending = false;
function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  setTimeout(() => {
    syncPending = false;
    syncHistory();
  });
}

// A MutationObserver calls a function whenever the elements it watches change. Here: the
// drawers' class ("open") and each popup's open attribute (set by showModal(), removed by close()).
// That way none of the many places that open or close something need to know about history.
const historyObserver = new MutationObserver(scheduleSync);
for (const drawer of [sidebarElement, membersElement]) {
  historyObserver.observe(drawer, { attributes: true, attributeFilter: ["class"] });
}
for (const dialog of document.querySelectorAll("dialog")) {
  historyObserver.observe(dialog, { attributes: true, attributeFilter: ["open"] });
}

// Back (or forward) was pressed. event.state is the object we gave that step.
window.addEventListener("popstate", (event) => {
  steppingBack = false;
  const state = event.state;
  closeDrawers();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();

  if (state?.overlay) {
    // Forward into a "something was open" step: there's nothing to reopen, so skip past it.
    steppingBack = true;
    history.back();
    return;
  }
  const channel = state?.channel;
  if (!channel || channel === currentChannel) return;
  const partner = dmPartner(channel);
  if (partner !== null && !friendIds.has(partner)) {
    // A DM with someone who's no longer a friend: it's gone, so stay where we are.
    history.replaceState({ channel: currentChannel }, "");
    return;
  }
  switchChannel(channel, channelLabel(channel), true);
});

// ---------- Clicking outside a popup closes it ----------
// (A modal dialog's surroundings, the darkened "backdrop", count as the dialog itself for
// clicks, so the clicks arrive here. Not for the picture editor: a stray click next to it
// would throw away the cropping. It has Cancel and Esc.)

// Was this point outside the dialog's box on the screen? Measured, not "which element
// was clicked": the dialog's own padding inside the box would count as the dialog too.
function isOutside(dialog, event) {
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right
    || event.clientY < box.top || event.clientY > box.bottom;
}

// The press has to start outside too: selecting text in a field and letting go of the mouse
// outside the box also counts as a "click" there, and mustn't throw away what was typed.
let pressedOutside = false;

for (const dialog of document.querySelectorAll("dialog")) {
  // Not the picture editor, and not an incoming call (a stray click mustn't silence or decline it).
  if (dialog === cropperDialog || dialog.id === "incoming-call") continue;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOutside = isOutside(dialog, event);
  });
  dialog.addEventListener("click", (event) => {
    if (pressedOutside && isOutside(dialog, event)) dialog.close();
    pressedOutside = false;
  });
}

// ---------- The text box ----------

// A textarea doesn't grow by itself. Shrink it to nothing ("auto"), then make it as tall as
// its text needs (scrollHeight). The CSS max-height stops it at half the screen.
function autoGrow() {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
}

function clearInput() {
  input.value = "";
  autoGrow();  // back to one line
  closeAutocomplete();
  updateCharCount();
}

// ---------- Emoji autocomplete (typing ":po") ----------

const autocompleteBox = document.getElementById("autocomplete");
const MAX_SUGGESTIONS = 10;
let suggestions = [];   // [{value, insert, label, detail}], what the list shows
let suggestionIndex = 0;  // which one is highlighted
let codeStart = 0;      // where the ":" of the code being typed is, in the text

// A colon at the start or after a space, then name characters, right up to the cursor.
// (Only after a space, so links like https://… and times like 14:30 don't pop the list up.)
// At least 2 characters, so plain-text faces like :D :P :3 stay as typed (not 🐶 "dog").
const TYPING_CODE = /(^|\s):([A-Za-z0-9_]{2,32})$/;

// An @ at the start or after a space, then (maybe already) part of a name, up to the cursor.
// {0,32}: the list already shows right after typing "@".
const TYPING_MENTION = /(^|\s)@([A-Za-z0-9_-]{0,32})$/;

// The text box the list belongs to: the message box, or the edit box of a message being edited.
// There's one list (#autocomplete); it's moved next to whichever box you're typing in.
let typingIn = input;

function updateAutocomplete(area = input) {  // (= input: the message box, when no box is given)
  typingIn = area;
  // Its place: in the message form (above the box), or in the editor (below the box, so it isn't
  // cut off when editing a message at the top). appendChild moves an element that's already on the page.
  const home = area === input ? input.form : area.parentElement;
  if (autocompleteBox.parentElement !== home) home.appendChild(autocompleteBox);
  const cursor = area.selectionStart;
  if (area.selectionEnd !== cursor) return closeAutocomplete();  // (text is selected)
  const before = area.value.slice(0, cursor);
  const mention = before.match(TYPING_MENTION);
  const code = before.match(TYPING_CODE);
  const match = mention || code;
  if (!match) return closeAutocomplete();
  const query = match[2].toLowerCase();
  codeStart = cursor - query.length - 1;  // the "@" or ":" just before what was typed
  suggestions = mention ? findPeople(query) : findSuggestions(query);
  if (suggestions.length === 0) return closeAutocomplete();
  suggestionIndex = 0;
  renderAutocomplete();
}

// People for "@ka": whoever can see this channel (in a DM: just the other person, and the AI bot,
// which a mention invites in), names starting with it first, then names containing it; and @everyone.
function findPeople(query) {
  const partner = dmPartner(currentChannel);
  const candidates = [...people.values()].filter((person) =>
    person.id !== myId && (partner === null || person.id === partner || person.bot)
  );
  const name = (person) => person.name.toLowerCase();
  const ordered = [
    ...candidates.filter((person) => name(person).startsWith(query)),
    ...candidates.filter((person) => !name(person).startsWith(query) && name(person).includes(query)),
  ];
  const results = ordered.map((person) => ({
    icon: () => makeAvatar(person.id, person.name, "tiny"),
    insert: "@" + person.name + " ",
    label: person.name,
    detail: person.status || (person.online ? "online" : ""),
  }));
  if ("everyone".startsWith(query)) {
    results.push({
      icon: () => document.createTextNode("📣"),
      insert: "@everyone ",
      label: "everyone",
      detail: "Notify everyone who can see this channel",
    });
  }
  return results.slice(0, MAX_SUGGESTIONS);
}

// Custom emoji first (names starting with the search, then names containing it),
// then normal emoji (same idea, using their names: "smil" finds "smiling face").
function findSuggestions(query) {
  const results = [];
  const ownerName = (id) => people.get(id)?.name ?? "";
  const customStarts = customEmoji.filter((e) => e.name.toLowerCase().startsWith(query));
  const customContains = customEmoji.filter((e) => !e.name.toLowerCase().startsWith(query) && e.name.toLowerCase().includes(query));
  for (const emoji of [...customStarts, ...customContains]) {
    results.push({
      icon: () => makeEmojiElement("custom:" + emoji.id), insert: ":" + emoji.name + ": ",
      label: ":" + emoji.name + ":", detail: ownerName(emoji.owner_id),
    });
  }

  if (emojiGroups && results.length < MAX_SUGGESTIONS) {
    const words = query.replaceAll("_", " ");  // ":thumbs_up" searches "thumbs up"
    const ranked = [];
    for (const group of emojiGroups) {
      for (const [emoji, name] of group.emoji) {
        // 0: exactly the name; 1: the name starts with it; 2: a later word starts with it;
        // 3: it's somewhere inside
        let rank = null;
        if (name === words) rank = 0;
        else if (name.startsWith(words)) rank = 1;
        else if (name.includes(" " + words)) rank = 2;
        else if (name.includes(words)) rank = 3;
        if (rank !== null) ranked.push({ rank: rank, emoji: emoji, name: name });
      }
    }
    // Best rank first; within a rank, shorter names first (usually the more basic emoji:
    // "fire" before "firecracker").
    ranked.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
    for (const { emoji, name } of ranked) {  // { } here takes these two fields out of each item
      results.push({ icon: () => makeEmojiElement(emoji), insert: emoji, label: name, detail: "" });
    }
  }
  return results.slice(0, MAX_SUGGESTIONS);
}

function renderAutocomplete() {
  autocompleteBox.replaceChildren();
  suggestions.forEach((suggestion, index) => {
    const row = document.createElement("button");
    row.type = "button";
    if (index === suggestionIndex) row.className = "active";
    row.appendChild(suggestion.icon());  // an emoji, or a person's picture
    const label = document.createElement("span");
    label.textContent = suggestion.label;
    row.appendChild(label);
    if (suggestion.detail) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = suggestion.detail;
      row.appendChild(detail);
    }
    // mousedown + preventDefault: clicking doesn't take the focus away from the text box.
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => pickSuggestion(index));
    autocompleteBox.appendChild(row);
  });
  autocompleteBox.hidden = false;
}

// Replace the typed ":po" with the chosen ":pog: " (or the emoji itself), cursor after it.
function pickSuggestion(index) {
  const suggestion = suggestions[index];
  const area = typingIn;
  const cursor = area.selectionStart;
  const newText = area.value.slice(0, codeStart) + suggestion.insert + area.value.slice(cursor);
  if (newText.length > maxTextLength) {  // maxlength only stops typing, not values set by code
    closeAutocomplete();
    if (area === input) updateCharCount("No room for that emoji: character limit reached");
    return;
  }
  area.value = newText;
  area.selectionStart = area.selectionEnd = codeStart + suggestion.insert.length;
  closeAutocomplete();
  // As if it had been typed: the box's own "input" listener grows it (and the edit box keeps its
  // draft). The list doesn't reopen: after the inserted space or emoji, nothing is being typed.
  area.dispatchEvent(new Event("input"));
  area.focus();
}

// ↑ ↓ Enter Tab Esc while the list is open belong to it (in the message box and in the edit box).
// True if the key was used for the list, so the box's own handler leaves it alone.
// isComposing: typing with an input method (e.g. Japanese), where Enter confirms a character.
function autocompleteKeydown(event) {
  // isConnected: still on the page. (A new message redraws the messages, editor and all: a list
  // that was open in the old editor is gone with it, and counts as closed.)
  if (autocompleteBox.hidden || !autocompleteBox.isConnected) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();  // don't move the cursor
    const step = event.key === "ArrowDown" ? 1 : -1;
    // % wraps around: past the last goes back to the first (and the other way round)
    suggestionIndex = (suggestionIndex + step + suggestions.length) % suggestions.length;
    renderAutocomplete();
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && !event.isComposing) {
    event.preventDefault();  // don't send or save / don't move focus
    pickSuggestion(suggestionIndex);
    return true;
  }
  if (event.key === "Escape") {
    // stopImmediatePropagation: the box's other Esc handlers (cancel a reply, cancel an edit)
    // don't get this keypress. Esc closes the list first; a second Esc does the rest.
    event.stopImmediatePropagation();
    closeAutocomplete();
    return true;
  }
  return false;
}

// The edit box gets the list too (messages.js, makeEditor): after every change, when the cursor
// moves, and closed when it loses focus. (Its keys: autocompleteKeydown, in its own handler.)
function useAutocomplete(area) {
  area.addEventListener("input", () => updateAutocomplete(area));
  area.addEventListener("click", () => updateAutocomplete(area));
  area.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateAutocomplete(area);
  });
  area.addEventListener("blur", closeAutocomplete);
}

function closeAutocomplete() {
  autocompleteBox.hidden = true;
  suggestions = [];
}

// Check after every change, and when the cursor moves (clicking, or arrow keys sideways).
useAutocomplete(input);
input.addEventListener("input", () => {
  autoGrow();
  updateCharCount();
});

// The keys. While the list is open, ↑ ↓ Enter Tab Esc belong to it (autocompleteKeydown).
// Enter (without Shift) otherwise sends; Shift+Enter starts a new line.
input.addEventListener("keydown", (event) => {
  if (autocompleteKeydown(event)) return;
  // ↑ in an empty text box: edit our last message (like Discord).
  if (event.key === "ArrowUp" && input.value === "") {
    const mine = shownMessages.filter((message) => message.user_id === myId);
    if (mine.length) {
      event.preventDefault();
      startEdit(mine[mine.length - 1]);  // the last one in the list is the newest
    }
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();  // no new line...
    form.requestSubmit();    // ...send instead (as if Send was clicked)
  }
});

// The 😀 next to the text box: opens the picker in "insert" mode (or closes it again).
const composeEmojiButton = document.getElementById("compose-emoji");
composeEmojiButton.addEventListener("click", () => {
  if (!emojiPicker.hidden && pickerMode === "insert") {
    closeEmojiPicker();
  } else {
    openEmojiPicker(null, composeEmojiButton, "insert");
  }
});

// Put text where the cursor is in the text box (replacing anything selected), cursor after it.
function insertAtCursor(text) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const newText = input.value.slice(0, start) + text + input.value.slice(end);
  if (newText.length > maxTextLength) {  // maxlength only stops typing, not values set by code
    updateCharCount("No room for that emoji: character limit reached");
    return;
  }
  input.value = newText;
  input.selectionStart = input.selectionEnd = start + text.length;
  autoGrow();
  updateCharCount();
}

// ---------- The character limit ----------

let maxTextLength = 2000;  // replaced by the server's limit when we connect (see "welcome")
const COUNT_FROM = 200;    // show the counter once this close to the limit
const charCount = document.getElementById("char-count");

// Show "1850 / 2000" near the limit, and a red warning at it (or `note`, a specific warning).
// .length counts UTF-16 units: many emoji count as 2 here but as 1 on the server, so the page
// reaches the limit a little early, never late. That's the safe direction.
function updateCharCount(note) {
  const length = input.value.length;
  if (note) {
    charCount.textContent = note;
    charCount.className = "limit";
  } else if (length >= maxTextLength) {
    charCount.textContent = `Character limit reached (${maxTextLength})`;
    charCount.className = "limit";
  } else if (length >= maxTextLength - COUNT_FROM) {
    charCount.textContent = `${length} / ${maxTextLength}`;
    charCount.className = "";
  } else {
    charCount.textContent = "";
  }
}

// Pasting more than fits: the browser cuts it off (because of maxlength). Say so.
input.addEventListener("paste", (event) => {
  const pasted = event.clipboardData.getData("text");
  const selected = input.selectionEnd - input.selectionStart;  // a selection gets replaced
  if (input.value.length - selected + pasted.length > maxTextLength) {
    // After the paste has happened (setTimeout 0 = "right after this event"), show the warning.
    setTimeout(() => updateCharCount(`Pasted text was cut off at ${maxTextLength} characters`), 0);
  }
});

// The user pressed Enter or clicked Send.
form.addEventListener("submit", (event) => {
  event.preventDefault();  // stop the browser from reloading the page
  if (sending) return;     // still busy sending the tray
  const text = input.value.trim();

  // Files waiting in the tray? Send those, with the text as the caption.
  if (tray.length > 0) {
    sendTray(text);
    return;
  }

  if (text === "") return;
  // Only the text: the server knows who we are and which channel we're in.
  // If we're disconnected, keep the text in the box so it can be sent later.
  if (!sendToServer({ type: "message", text: text, reply_to: replyingTo?.id })) return;
  clearInput();
  clearReply();
  lastTypingSent = 0;  // so typing the next message is announced straight away
});

// Log out: the server forgets our session, then we go back to the login page.
logoutButton.addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  location.href = "/login";
});
