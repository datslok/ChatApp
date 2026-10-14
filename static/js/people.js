// People: the DM list and the online list, friends, the profile popup, "is typing…".
//
// One of the chat page's scripts (static/js/), loaded in order by static/index.html. They're
// plain scripts sharing one global scope: what one file declares, the others can use.

// ---------- People: DM list and online list ----------

// The statuses, by their names on the server (users.presence; "offline" is only ever shown).
const PRESENCE_NAMES = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" };

// The little dot on someone's picture: green, a yellow moon (idle), red (do not disturb), or grey
// (offline; a grey ring for our own Invisible). Its colour comes from the CSS class.
function makeDot(presence) {
  const dot = document.createElement("span");
  dot.className = "dot " + presence;
  dot.title = PRESENCE_NAMES[presence] ?? "";
  return dot;
}

// Everyone we know about, by id: {3 => {id, name, online, avatar, status, bio}, ...}.
// Filled from the server's "users" list. Messages only carry the sender's id, and look
// up the picture here, so a changed picture shows up everywhere at once.
const people = new Map();

// The roles, from the server's "roles", the top one first: [{id, name, colour}, ...]. Each person
// has the ids of theirs (top first) in their "roles"; the top one colours their name.
let roles = [];

// Someone's top role, or undefined (no roles, or one that's just been deleted).
function topRole(userId) {
  const ids = people.get(userId)?.roles ?? [];
  return roles.find((role) => ids.includes(role.id));  // (roles is in order: the first found is the top one)
}

// The colour for someone's name: their top role's, or "" (the theme's own).
function nameColour(userId) {
  return topRole(userId)?.colour ?? "";
}

// Colours for the letter circles. Each person always gets the same one (their id picks it).
const LETTER_COLOURS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];

function colourFor(userId) {
  return userId ? LETTER_COLOURS[userId % LETTER_COLOURS.length] : "#4e5058";
}

// A profile banner: the picture if the person has one, otherwise a plain strip in their colour.
function makeBanner(userId) {
  const person = people.get(userId);
  let banner;
  if (person && person.banner) {
    banner = document.createElement("img");
    banner.src = "/banners/" + encodeURIComponent(person.banner);
    banner.alt = "";
  } else {
    banner = document.createElement("div");
    banner.style.background = colourFor(userId);
  }
  banner.classList.add("banner");
  return banner;
}

// A profile picture: the real one if the person has one, otherwise a coloured circle with
// their first letter. `size` is "small", "" (normal) or "large".
// userId can be null: messages from before accounts existed (we only have the typed name).
function makeAvatar(userId, name, size) {
  const person = people.get(userId);
  let avatar;
  if (person && person.avatar) {
    avatar = document.createElement("img");
    avatar.src = "/avatars/" + encodeURIComponent(person.avatar);
    avatar.alt = "";  // decorative: the name is always shown next to it
  } else {
    avatar = document.createElement("div");
    avatar.classList.add("letter");
    avatar.textContent = (name || "?").charAt(0).toUpperCase();
    avatar.style.background = colourFor(userId);
  }
  avatar.classList.add("avatar");
  if (size) avatar.classList.add(size);
  // Remember whose picture this is, so it can be redrawn when they change it.
  avatar.dataset.avatarFor = userId ?? "";  // ?? means "or, if it's null/undefined"
  avatar.dataset.avatarName = name || "";
  avatar.dataset.avatarSize = size || "";
  return avatar;
}

// After a "users" update: replace every picture on the page with a fresh one, so changed
// pictures appear on old messages too, without reloading anything.
function redrawAvatars() {
  for (const old of document.querySelectorAll("[data-avatar-for]")) {
    if (old.dataset.avatarFor === "") continue;  // pre-account messages never change
    const userId = Number(old.dataset.avatarFor);
    const fresh = makeAvatar(userId, old.dataset.avatarName, old.dataset.avatarSize);
    if (old.classList.contains("clickable")) fresh.classList.add("clickable");
    if (old.dataset.userMenu) fresh.dataset.userMenu = old.dataset.userMenu;  // (right-click: the user menu)
    old.replaceWith(fresh);
  }
}

// The little "BOT" tag after a bot's name (in the lists, above its messages, in its profile).
function makeBotBadge() {
  const badge = document.createElement("span");
  badge.className = "bot-badge";
  badge.textContent = "BOT";
  return badge;
}

// A row for one person: picture with an online dot, name, and status underneath.
function makePerson(user) {
  const row = document.createElement("span");
  row.className = "person";

  const picture = document.createElement("span");
  picture.className = "person-picture";
  picture.appendChild(makeAvatar(user.id, user.name, "small"));
  // What the others see; but we see our own Invisible as such (they see us offline).
  const presence = user.id === myId && myPresence === "invisible" ? "invisible"
    : user.presence ?? (user.online ? "online" : "offline");
  picture.appendChild(makeDot(presence));
  row.appendChild(picture);

  const text = document.createElement("span");
  text.className = "person-text";
  const name = document.createElement("span");
  name.textContent = user.name;
  name.style.color = nameColour(user.id);  // (their top role's colour, or none)
  if (user.bot) name.appendChild(makeBotBadge());
  text.appendChild(name);
  if (user.status) {
    const status = document.createElement("span");
    status.className = "person-status";
    status.textContent = user.status;
    text.appendChild(status);
  }
  row.appendChild(text);
  return row;
}

// `users` is every account: [{id: 3, name: "axel", online: true, avatar, status, bio}, ...]
function showUsers(users) {
  people.clear();
  for (const user of users) people.set(user.id, user);

  renderDmList();

  // The right column: bots in a section of their own at the top, then a section for each role with
  // its online people (by their top role, like Discord), then the online people without a role, and
  // everyone offline at the bottom (all alphabetical, as the server sent them). Click someone for
  // their profile.
  const bots = users.filter((user) => user.bot);
  const humans = users.filter((user) => !user.bot);  // ! means "not"
  const online = humans.filter((user) => user.online && !topRole(user.id));
  const offline = humans.filter((user) => !user.online);
  botsHeading.hidden = botsList.hidden = bots.length === 0;  // (no bots: as if the section weren't there)
  botsHeading.textContent = `Bots — ${bots.length}`;
  fillPeopleList(botsList, bots);
  roleSections.replaceChildren();
  for (const role of roles) {
    const members = humans.filter((user) => user.online && topRole(user.id) === role);
    if (members.length === 0) continue;  // (a role with nobody online: no empty heading)
    const heading = document.createElement("h2");
    heading.className = "section-heading";
    heading.textContent = `${role.name} — ${members.length}`;  // (textContent: an admin typed the name)
    const list = document.createElement("ul");
    fillPeopleList(list, members);
    roleSections.append(heading, list);
  }
  onlineHeading.textContent = `Online — ${online.length}`;
  offlineHeading.textContent = `Offline — ${offline.length}`;
  fillPeopleList(onlineList, online);
  fillPeopleList(offlineList, offline);

  redrawAvatars();  // messages, the profile popup and Settings
  renderUserPanel();  // you, at the bottom left
  // Banners only appear in two places, so those are simply redrawn if they're open.
  if (profileDialog.open) renderProfile(profileUserId);
  if (settingsDialog.open) settingsBanner.replaceChildren(makeBanner(myId));
  if (currentChannel === FRIENDS) renderPeopleList();  // names, pictures, online dots
}

function fillPeopleList(list, users) {
  list.replaceChildren();
  for (const user of users) {
    const item = document.createElement("li");
    item.classList.add("clickable");
    item.dataset.userMenu = user.id;  // (right-click: the user menu)
    item.appendChild(makePerson(user));
    item.addEventListener("click", () => openProfile(user.id));
    list.appendChild(item);
  }
}

// DM list in the sidebar: our group DMs first, then friends (DMs are only allowed between friends).
function renderDmList() {
  dmList.replaceChildren();
  for (const group of groups.values()) {
    const button = document.createElement("button");
    button.className = "channel";
    button.dataset.channel = group.key;
    button.appendChild(makeGroupRow(group));
    button.addEventListener("click", () => switchChannel(group.key, channelLabel(group.key)));
    dmList.appendChild(button);
  }
  for (const user of people.values()) {  // a Map remembers the order: alphabetical, from the server
    if (!friendIds.has(user.id)) continue;
    const button = document.createElement("button");
    button.className = "channel";
    button.dataset.channel = dmChannel(user.id);
    button.dataset.userMenu = user.id;  // (right-click: the user menu)
    button.appendChild(makePerson(user));
    button.addEventListener("click", () => switchChannel(dmChannel(user.id), "@" + user.name));
    dmList.appendChild(button);
  }
  if (friendIds.size === 0 && groups.size === 0) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "Add friends to send direct messages.";
    dmList.appendChild(note);
  }
  updateSidebar();  // the buttons are new, so mark the active and unread ones again
}

// ---------- Friends ----------

// Our own friends and friend requests, as user ids. Filled by the server's "friends" message.
const friendIds = new Set();
const incomingIds = new Set();  // they asked us
const outgoingIds = new Set();  // we asked them
const blockedIds = new Set();   // people we blocked (the server's "blocks"): their messages are hidden for us
let peopleTab = "friends";      // which tab of the Friends page is showing

function setAll(set, ids) {
  set.clear();
  for (const id of ids) set.add(id);
}

// Our friends or requests changed: redraw everything that depends on them.
function friendsChanged() {
  renderDmList();
  requestBadge.textContent = incomingIds.size;
  requestBadge.hidden = incomingIds.size === 0;
  requestsTabCount.textContent = incomingIds.size > 0 ? `(${incomingIds.size})` : "";
  updateSidebar();  // the dot on ☰ (phones) also counts friend requests
  if (currentChannel === FRIENDS) renderPeopleList();
  if (profileDialog.open) renderProfile(profileUserId);

  // Looking at a DM with someone who's no longer a friend? Then it's gone: go to the first channel.
  const other = dmPartner(currentChannel);
  if (other !== null && !friendIds.has(other)) {
    switchChannel(firstChannel, channelLabel(firstChannel));
  }
}

// The other person in a DM channel name ("dm:3:7" -> 7 when we are 3), or null for normal channels.
function dmPartner(channel) {
  if (!channel || !channel.startsWith("dm:")) return null;
  const ids = channel.split(":").slice(1).map(Number);  // "dm:3:7" -> [3, 7]
  return ids[0] === myId ? ids[1] : ids[0];
}

// Ask the server to change a friendship. It answers everyone involved with a fresh
// "friends" message, which redraws the lists, so we only need to handle errors here.
async function friendAction(action, userId, statusElement) {
  statusElement.textContent = "";
  const result = await postJson("/friends/" + action, { user_id: userId });
  if (!result.ok) statusElement.textContent = result.error;
}

function openDm(userId) {
  const person = people.get(userId);
  profileDialog.close();
  switchChannel(dmChannel(userId), "@" + person.name);
}

// The buttons for one person, depending on how we're connected.
function makeFriendButtons(userId, statusElement) {
  const buttons = [];
  function add(label, onClick, secondary) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (secondary) button.className = "secondary";
    button.addEventListener("click", (event) => {
      event.stopPropagation();  // don't also count as a click on the row (which opens the profile)
      onClick();
    });
    buttons.push(button);
  }

  if (blockedIds.has(userId)) {
    add("Unblock", () => friendAction("unblock", userId, statusElement), true);
    return buttons;  // (nothing else until they're unblocked: no friend request, no DM)
  }
  if (friendIds.has(userId)) {
    add("Message", () => openDm(userId));
    // Bots are everyone's friend (the server adds and keeps those friendships): no Remove.
    if (!people.get(userId)?.bot) add("Remove", () => friendAction("remove", userId, statusElement), true);
  } else if (incomingIds.has(userId)) {
    add("Accept", () => friendAction("accept", userId, statusElement));
    add("Decline", () => friendAction("remove", userId, statusElement), true);
  } else if (outgoingIds.has(userId)) {
    add("Cancel request", () => friendAction("remove", userId, statusElement), true);
  } else {
    add("Add friend", () => friendAction("request", userId, statusElement));
  }
  // Block: not admins (the chat's rule) or bots (everyone's friend). The server checks too.
  const person = people.get(userId);
  if (person && !person.admin && !person.bot) {
    add("Block", () => {
      const question = `Block ${person.name}? You stop being friends, and their messages are hidden for you. They aren't told.`;
      if (confirm(question)) friendAction("block", userId, statusElement);
    }, true);
  }
  return buttons;
}

// One person on the Friends page: picture, name and status (click for their profile), and buttons.
function makePeopleRow(user) {
  const row = document.createElement("div");
  row.className = "people-row clickable";
  row.dataset.userMenu = user.id;  // (right-click: the user menu)
  row.appendChild(makePerson(user));
  const actions = document.createElement("div");
  actions.className = "friend-actions";
  actions.append(...makeFriendButtons(user.id, peopleStatus));  // ... spreads the list into separate arguments
  row.appendChild(actions);
  row.addEventListener("click", () => openProfile(user.id));
  return row;
}

function renderPeopleList() {
  peopleList.replaceChildren();
  const everyone = [...people.values()].filter((user) => user.id !== myId);

  function section(title, users, emptyText) {
    if (title) {
      const heading = document.createElement("h3");
      heading.className = "people-subheading";
      heading.textContent = title;
      peopleList.appendChild(heading);
    }
    for (const user of users) peopleList.appendChild(makePeopleRow(user));
    if (users.length === 0) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = emptyText;
      peopleList.appendChild(note);
    }
  }

  if (peopleTab === "friends") {
    section("", everyone.filter((user) => friendIds.has(user.id)),
      "No friends yet. Click someone's name or picture in a channel to add them.");
  } else if (peopleTab === "blocked") {
    section("", everyone.filter((user) => blockedIds.has(user.id)), "You haven't blocked anyone.");
  } else {
    section("Received", everyone.filter((user) => incomingIds.has(user.id)), "No requests waiting.");
    section("Sent", everyone.filter((user) => outgoingIds.has(user.id)), "You haven't sent any requests.");
  }
}

friendsButton.addEventListener("click", () => switchChannel(FRIENDS, "Friends"));

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    peopleTab = tab.dataset.tab;
    for (const other of document.querySelectorAll(".tab")) {
      other.classList.toggle("active", other === tab);
    }
    peopleStatus.textContent = "";
    renderPeopleList();
  });
}

// ---------- Group DMs ----------
//
// Private chats for 3 to 10 people. The server sends our own groups in a "groups" message, at the
// start and after every change (someone made one with us, added people, renamed it, left):
// [{key: "g:5f3a9b21", name: "Weekend plans" or null, members: [3, 7, 12]}]. Messages in a group
// work like in a channel; its key is the "channel" they're saved under. Calls work like a DM's
// (rooms.js), ringing everyone else, with a tile for everyone in the call like the Lounge.

const MAX_GROUP_SIZE = 10;  // as the server's
const groups = new Map();   // key -> the group, in the order the server sent them (oldest first)
const groupDialog = document.getElementById("group-dialog");
const groupForm = document.getElementById("group-form");
const groupDialogTitle = document.getElementById("group-dialog-title");
const groupDialogHelp = document.getElementById("group-dialog-help");
const groupFriends = document.getElementById("group-friends");
const groupNameRow = document.getElementById("group-name-row");
const groupNameInput = document.getElementById("group-name");
const groupStatus = document.getElementById("group-status");
const groupSubmit = document.getElementById("group-submit");
const groupMembersLine = document.getElementById("group-members");
const groupButtons = document.getElementById("group-buttons");
let groupDialogKey = null;  // null: the popup starts a new group; a key: it adds people to that one

function isGroup(channel) {
  return typeof channel === "string" && channel.startsWith("g:");
}

// A group's people: its members without the bots (every bot is in every group, see server.py).
function groupPeople(group) {
  return group.members.filter((id) => !people.get(id)?.bot);
}

// What a group is called: its name, or the other people's names ("kari, ola").
function groupLabel(key) {
  const group = groups.get(key);
  if (!group) return "a group";
  if (group.name) return group.name;
  const others = groupPeople(group).filter((id) => id !== myId).map((id) => people.get(id)?.name ?? "someone");
  return others.length ? others.join(", ") : "Just you";
}

// The server's "groups": ours changed (or we just connected).
function setGroups(list) {
  groups.clear();
  for (const group of list) groups.set(group.key, group);
  renderDmList();
  if (isGroup(voiceRoomName) && !groups.has(voiceRoomName)) leaveVoice();  // left a group while in its call
  if (isGroup(currentChannel)) {
    if (groups.has(currentChannel)) {
      setLabel(channelLabel(currentChannel));  // (renamed, or people came or went)
    } else {
      switchChannel(firstChannel, channelLabel(firstChannel));  // we left it (perhaps on another device)
    }
  }
}

// A group in the DM list: a 👥 circle, its name, and how many are in it.
function makeGroupRow(group) {
  const row = document.createElement("span");
  row.className = "person";
  const picture = document.createElement("span");
  picture.className = "person-picture";
  const circle = document.createElement("div");
  circle.className = "avatar small letter group-avatar";
  circle.textContent = "👥";
  picture.appendChild(circle);
  row.appendChild(picture);
  const text = document.createElement("span");
  text.className = "person-text";
  const name = document.createElement("span");
  name.textContent = groupLabel(group.key);
  const count = document.createElement("span");
  count.className = "person-status";
  count.textContent = `${groupPeople(group).length} members`;
  text.append(name, count);
  row.appendChild(text);
  return row;
}

// The bar at the top of a group (called by showDmHeader, rooms.js): who's in it, and its buttons.
function showGroupHeader() {
  const inGroup = isGroup(currentChannel) && groups.has(currentChannel);
  groupMembersLine.hidden = groupButtons.hidden = !inGroup;
  if (!inGroup) return;
  const names = groups.get(currentChannel).members.map((id) => (id === myId ? "you" : people.get(id)?.name ?? "someone"));
  groupMembersLine.textContent = names.join(", ");
}

// The popup: starting a new group (key null), or adding people to one. It lists our friends who
// aren't in it yet, each with a checkbox.
function openGroupDialog(key) {
  closeDrawers();  // (on a phone, the + is in the sidebar drawer)
  groupDialogKey = key;
  const members = key ? groupPeople(groups.get(key)) : [myId];
  groupDialogTitle.textContent = key ? "Add people" : "New group";
  groupDialogHelp.textContent = key
    ? `Pick friends to add (up to ${MAX_GROUP_SIZE - members.length} more). They'll see the whole chat.`
    : `Pick 2 to ${MAX_GROUP_SIZE - 1} friends. Everyone in a group can read and write in it, add their own friends, and leave. Chattus is in every group: write @Chattus to ask him something.`;
  groupNameRow.hidden = key !== null;  // (renaming has its own button)
  groupNameInput.value = "";
  groupStatus.textContent = "";
  groupSubmit.textContent = key ? "Add" : "Create group";
  // Friends not in it yet; never bots (they're in every group by themselves).
  const choices = [...people.values()].filter((person) =>
    friendIds.has(person.id) && !person.bot && !members.includes(person.id));
  groupFriends.replaceChildren(...choices.map(makeGroupChoice));
  if (choices.length === 0) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = key ? "All your friends are in it already." : "Add friends first: groups are made with friends.";
    groupFriends.appendChild(note);
  }
  updateGroupChoices();
  groupDialog.showModal();
}

// One friend to tick. Inside a <label>, a click anywhere on the row ticks the box.
function makeGroupChoice(person) {
  const label = document.createElement("label");
  label.className = "group-choice";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = person.id;  // (a checkbox's value is text: Number() turns it back below)
  box.addEventListener("change", updateGroupChoices);
  label.append(box, makePerson(person));
  return label;
}

function chosenFriends() {
  // ":checked" in a selector: only the ticked boxes.
  return [...groupFriends.querySelectorAll("input:checked")].map((box) => Number(box.value));
}

// After each tick: at the size limit, the unticked boxes can't be ticked; and the button only
// works with enough people picked (2 for a new group, 1 to add).
function updateGroupChoices() {
  const already = groupDialogKey ? groupPeople(groups.get(groupDialogKey)).length : 1;
  const chosen = chosenFriends().length;
  for (const box of groupFriends.querySelectorAll("input")) {
    box.disabled = !box.checked && already + chosen >= MAX_GROUP_SIZE;
  }
  groupSubmit.disabled = chosen < (groupDialogKey ? 1 : 2);
}

groupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = groupDialogKey;
  groupSubmit.disabled = true;  // (no double groups from a double click)
  const result = key
    ? await postJson(`/groups/${encodeURIComponent(key)}/add`, { user_ids: chosenFriends() })
    : await postJson("/groups", { user_ids: chosenFriends(), name: groupNameInput.value });
  if (!result.ok) {
    groupStatus.textContent = result.error;
    updateGroupChoices();
    return;
  }
  groupDialog.close();
  // A new group: go there. (Its name arrives with the "groups" message, which corrects the label.)
  if (!key) switchChannel(result.data.key, channelLabel(result.data.key));
});

document.getElementById("group-cancel").addEventListener("click", () => groupDialog.close());
document.getElementById("new-group").addEventListener("click", () => openGroupDialog(null));
document.getElementById("group-add").addEventListener("click", () => openGroupDialog(currentChannel));

// Rename: the browser's own question box. prompt() gives back the text, or null for Cancel.
document.getElementById("group-rename").addEventListener("click", async () => {
  const key = currentChannel;
  const name = prompt("Group name (leave it empty to name it after its members):", groups.get(key)?.name ?? "");
  if (name === null) return;
  const result = await postJson(`/groups/${encodeURIComponent(key)}/rename`, { name });
  if (!result.ok) alert(result.error);
});

document.getElementById("group-leave").addEventListener("click", async () => {
  const key = currentChannel;
  const group = groups.get(key);
  const question = group && groupPeople(group).length === 1
    ? "Leave this group? You're the last one in it, so it's deleted with all its messages."
    : `Leave ${groupLabel(key)}? You can only come back if someone adds you again.`;
  if (!confirm(question)) return;
  const result = await postJson(`/groups/${encodeURIComponent(key)}/leave`, {});
  if (!result.ok) alert(result.error);
  // (The "groups" message that follows takes us out of it: setGroups.)
});

// ---------- Profile popup ----------

const profileVolumeRow = document.getElementById("profile-volume-row");
const profileVolumeSlider = document.getElementById("profile-volume");
const profileVolumeValue = document.getElementById("profile-volume-value");

let profileUserId = null;  // whose profile is open
const profileRoles = document.getElementById("profile-roles");
const roleSections = document.getElementById("role-sections");

function openProfile(userId) {
  if (!people.has(userId)) return;  // pre-account messages have no profile
  profileUserId = userId;
  closeDrawers();
  renderProfile(userId);
  profileDialog.showModal();
}

// Fill the popup with someone's profile. Also used to refresh it while it's open.
function renderProfile(userId) {
  const person = people.get(userId);
  if (!person) return;
  profileBanner.replaceChildren(makeBanner(userId));
  profileAvatar.replaceChildren(makeAvatar(userId, person.name, "large"));
  profileName.textContent = person.name;
  if (person.admin) {
    const badge = document.createElement("span");
    badge.className = "admin-badge";
    badge.textContent = "Admin";
    profileName.appendChild(badge);
  }
  if (person.bot) profileName.appendChild(makeBotBadge());
  // Their roles, as small tags with a dot of each role's colour (top role first).
  profileRoles.replaceChildren(...roles.filter((role) => (person.roles ?? []).includes(role.id)).map((role) => {
    const tag = document.createElement("span");
    tag.className = "role-tag";
    const dot = document.createElement("span");
    dot.className = "role-dot";
    dot.style.background = role.colour;
    tag.append(dot, role.name);
    return tag;
  }));
  profileRoles.hidden = profileRoles.childElementCount === 0;
  profileStatus.textContent = person.status || "";
  profileBio.textContent = person.bio || "";
  profileActionStatus.textContent = "";
  // Message / Add friend / Accept / ... (nothing on your own profile).
  profileActions.replaceChildren(...(userId === myId ? [] : makeFriendButtons(userId, profileActionStatus)));
  // How loud they are for you in voice (see "Voice"). Not for yourself.
  profileVolumeRow.hidden = userId === myId;
  showProfileVolume(personVolume(userId));
}

function showProfileVolume(percent) {
  profileVolumeSlider.value = percent;
  profileVolumeValue.textContent = percent + "%";
}

profileVolumeSlider.addEventListener("input", () => {
  const percent = Number(profileVolumeSlider.value);
  showProfileVolume(percent);
  setPersonVolume(profileUserId, percent);
});

profileClose.addEventListener("click", () => profileDialog.close());

// ---------- You, at the bottom left (like Discord) ----------
//
// The panel: your picture (with the online dot), name and status, then 🎤 mute, 🎧 deafen and
// ⚙️ Settings. Clicking your picture or name opens #me-popup just above it: your profile, the
// call you're in (with "Open call"), Edit profile and Log out.

const userPanelMe = document.getElementById("user-panel-me");
const userMuteButton = document.getElementById("user-mute");
const userDeafenButton = document.getElementById("user-deafen");
const mePopup = document.getElementById("me-popup");

// Drawn again whenever something in it changes: the people list (your name, picture, status)
// and mute or deafen (rooms.js, showMuteButton).
function renderUserPanel() {
  const me = people.get(myId);
  if (me) userPanelMe.replaceChildren(makePerson(me));  // (the same as in the online list)
  userPanelMe.dataset.userMenu = myId;  // (right-click: Profile, Edit profile)
  userMuteButton.classList.toggle("off", micMuted);
  userMuteButton.title = micMuted ? "Unmute" : "Mute";
  userMuteButton.setAttribute("aria-label", userMuteButton.title);
  userDeafenButton.classList.toggle("off", deafened);
  userDeafenButton.title = deafened ? "Undeafen" : "Deafen";
  userDeafenButton.setAttribute("aria-label", userDeafenButton.title);
  if (mePopup.open) renderMePopup();
}

userMuteButton.addEventListener("click", toggleMute);
userDeafenButton.addEventListener("click", toggleDeafen);

function renderMePopup() {
  const me = people.get(myId);
  if (!me) return;
  document.getElementById("me-banner").replaceChildren(makeBanner(myId));
  document.getElementById("me-avatar").replaceChildren(makeAvatar(myId, me.name, "large"));
  document.getElementById("me-name").textContent = me.name;
  document.getElementById("me-status").textContent = me.status || "";
  renderPresencePicker();

  // In voice: where ("Lounge", "@alex") and the pictures of who's there (the server's lists:
  // voiceMembers for Lounge, dmCalls for a DM's call).
  const callSection = document.getElementById("me-call");
  callSection.hidden = !voiceRoomName;
  if (!voiceRoomName) return;
  const where = voiceRoomName === "lounge" ? LOUNGE : voiceRoomName;
  const members = (voiceRoomName === "lounge" ? voiceMembers.lounge : dmCalls[voiceRoomName]) || [];
  document.getElementById("me-call-where").textContent = channelLabel(where);
  document.getElementById("me-call-pictures").replaceChildren(
    ...members.slice(0, 5).map(({ id }) => makeAvatar(id, people.get(id)?.name, "small")),
  );
}

// Our status: a row for each, with its dot and what it means; the chosen one highlighted. Picking
// one tells the server, which tells all our pages ("my_presence") and everyone else ("users").
const PRESENCES_CHOSEN = ["online", "idle", "dnd", "invisible"];  // the ones you can choose (server.py, PRESENCES)
const PRESENCE_HELP = {
  online: "",
  idle: "Shown as away",
  dnd: "No notifications or sounds, on any device",
  invisible: "You look offline, but can chat as usual",
};

function renderPresencePicker() {
  document.getElementById("me-presence-options").replaceChildren(...PRESENCES_CHOSEN.map((presence) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "presence-option";
    row.setAttribute("aria-pressed", presence === myPresence ? "true" : "false");
    const text = document.createElement("span");
    text.className = "presence-text";
    const name = document.createElement("span");
    name.textContent = PRESENCE_NAMES[presence];
    text.appendChild(name);
    if (PRESENCE_HELP[presence]) {
      const help = document.createElement("span");
      help.className = "presence-help";
      help.textContent = PRESENCE_HELP[presence];
      text.appendChild(help);
    }
    row.append(makeDot(presence), text);
    row.addEventListener("click", () => {
      if (presence !== myPresence) sendToServer({ type: "presence", presence });
      mePopup.close();
    });
    return row;
  }));
}

// Open it just above the panel, at the panel's left edge (like the connection popup, voice.js).
userPanelMe.addEventListener("click", () => {
  renderMePopup();
  mePopup.showModal();
  const panel = document.getElementById("user-panel").getBoundingClientRect();
  mePopup.style.left = Math.max(8, Math.min(panel.left, innerWidth - mePopup.offsetWidth - 8)) + "px";
  mePopup.style.bottom = (innerHeight - panel.top + 8) + "px";
});

// "Open call": to the Lounge page, or the DM the call is in.
document.getElementById("me-open-call").addEventListener("click", () => {
  mePopup.close();
  const where = voiceRoomName === "lounge" ? LOUNGE : voiceRoomName;
  if (where) switchChannel(where, channelLabel(where));
});

// "Edit profile": Settings, straight on the Profile tab.
document.getElementById("me-edit-profile").addEventListener("click", () => {
  mePopup.close();
  settingsButton.click();
  showSettingsPage("profile");
});

// ---------- The user menu ----------
//
// Right-click a person (a long press on a phone: the browser turns it into the same "contextmenu"
// event): their picture or name above a message, a row in the member list, the DM list or the
// Friends page, a call tile. Each of those has data-user-menu="7" (the person's id), and one
// listener on the whole page finds it ("event delegation": one listener for every such element,
// also the ones drawn later). The menu is filled anew each time, for how we stand with them.

const contextMenu = document.getElementById("context-menu");

// Each item: [label, what it does], "-" for a line between groups, or [label, action, "danger"] in red.
function userMenuItems(userId) {
  const person = people.get(userId);
  if (userId === myId) {
    return [
      ["Profile", () => openProfile(userId)],
      ["Edit profile", () => {
        settingsButton.click();
        showSettingsPage("profile");
      }],
    ];
  }
  const items = [["Profile", () => openProfile(userId)]];
  if (!channelView.hidden) {  // (in a chat, where there's a message box to type in)
    items.push(["Mention", () => {
      insertAtCursor("@" + person.name + " ");  // (ui.js)
      input.focus();
    }]);
  }
  if (blockedIds.has(userId)) {
    items.push("-", ["Unblock", () => friendAction("unblock", userId, peopleStatus)]);
    return items;
  }
  if (friendIds.has(userId)) {
    items.push(["Message", () => openDm(userId)]);
    if (!person.bot) {
      items.push(["Call", () => {
        openDm(userId);
        callButton.click();  // (rooms.js: rings them, in the DM we just opened)
      }]);
    }
  }
  items.push("-");
  if (friendIds.has(userId)) {
    if (!person.bot) {
      items.push(["Remove friend", () => {
        if (confirm(`Remove ${person.name} as a friend? Your DM is kept, hidden, until you're friends again.`)) {
          friendAction("remove", userId, peopleStatus);
        }
      }]);
    }
    // Mute or unmute our DM with them (rooms.js has the same as 🔔). Not with an admin: they can't be muted.
    if (!person.admin) {
      const dm = dmChannel(userId);
      const muted = mutedChats.has(dm);
      items.push([muted ? "Unmute DM" : "Mute DM", () => sendToServer({ type: "mute", channel: dm, muted: !muted })]);
    }
  } else if (incomingIds.has(userId)) {
    items.push(["Accept friend request", () => friendAction("accept", userId, peopleStatus)]);
    items.push(["Decline friend request", () => friendAction("remove", userId, peopleStatus)]);
  } else if (outgoingIds.has(userId)) {
    items.push(["Cancel friend request", () => friendAction("remove", userId, peopleStatus)]);
  } else {
    items.push(["Add friend", () => friendAction("request", userId, peopleStatus)]);
  }
  if (!person.admin && !person.bot) {  // (admins and bots can't be blocked)
    items.push(["Block", () => {
      if (confirm(`Block ${person.name}? You stop being friends, and their messages are hidden for you. They aren't told.`)) {
        friendAction("block", userId, peopleStatus);
      }
    }, "danger"]);
  }
  return items;
}

// Show the menu at the pointer (kept inside the window), with the person's name on top.
function openUserMenu(event, userId) {
  const person = people.get(userId);
  if (!person) return;  // (messages from before accounts existed have no one behind them)
  event.preventDefault();  // instead of the browser's own menu
  closeDrawers();  // (a phone's sidebar drawer: the menu goes over the chat)
  // In fullscreen (a call or shared screen) only what's inside the fullscreen element is drawn, and
  // while a popup (a modal dialog: pins, search) is open nothing outside it can be clicked: so put the
  // menu in there, and back in the page's body otherwise. (appendChild moves an element.)
  const home = event.target.closest("dialog") || document.fullscreenElement || document.body;
  if (contextMenu.parentElement !== home) home.appendChild(contextMenu);
  const title = document.createElement("div");
  title.className = "context-title";
  title.textContent = person.name;
  contextMenu.replaceChildren(title);
  for (const item of userMenuItems(userId)) {
    if (item === "-") {
      if (contextMenu.lastChild.tagName !== "HR") contextMenu.appendChild(document.createElement("hr"));
      continue;
    }
    const [label, action, style] = item;  // (taking the list apart: "destructuring")
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    if (style === "danger") button.className = "danger";
    button.addEventListener("click", () => {
      closeContextMenu();
      action();
    });
    contextMenu.appendChild(button);
  }
  if (contextMenu.lastChild.tagName === "HR") contextMenu.lastChild.remove();  // (no line at the very end)
  contextMenu.hidden = false;
  // Where the pointer is, but moved back in if it would stick out past the window's right or bottom edge.
  const x = Math.min(event.clientX, innerWidth - contextMenu.offsetWidth - 8);
  const y = Math.min(event.clientY, innerHeight - contextMenu.offsetHeight - 8);
  contextMenu.style.left = Math.max(8, x) + "px";
  contextMenu.style.top = Math.max(8, y) + "px";
}

function closeContextMenu() {
  contextMenu.hidden = true;
}

// The one listener: a right-click (or long press) inside anything with data-user-menu opens the menu.
document.addEventListener("contextmenu", (event) => {
  const target = event.target.closest("[data-user-menu]");
  if (target) openUserMenu(event, Number(target.dataset.userMenu));
});
// Closed by a press anywhere else, Esc, scrolling (the person moves away under it), or the window changing.
document.addEventListener("pointerdown", (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});
document.addEventListener("scroll", closeContextMenu, true);  // (true: scrolling inside any box, like the messages)
window.addEventListener("resize", closeContextMenu);
window.addEventListener("blur", closeContextMenu);

// ---------- "is typing…" ----------

// Sending: the "input" event fires on every keystroke, but we tell the server
// at most once every 2 seconds (throttling), so we don't flood it.
let lastTypingSent = 0;  // when we last sent "typing", in milliseconds
input.addEventListener("input", () => {
  const now = Date.now();  // milliseconds since 1970: a simple clock
  if (input.value.trim() !== "" && now - lastTypingSent > 2000) {
    if (sendToServer({ type: "typing" })) {
      lastTypingSent = now;
    }
  }
});

// Showing: who's typing, each with a timer that removes them after 3 quiet seconds.
const typers = new Map();  // name -> timer id

function showTyping(name) {
  clearTimeout(typers.get(name));  // cancel their old timer, if any...
  const timer = setTimeout(() => stopTyping(name), 3000);  // ...and start a fresh one
  typers.set(name, timer);
  updateTypingLine();
}

function stopTyping(name) {
  clearTimeout(typers.get(name));
  typers.delete(name);
  updateTypingLine();
}

function clearTyping() {
  for (const timer of typers.values()) {
    clearTimeout(timer);
  }
  typers.clear();
  updateTypingLine();
}

function updateTypingLine() {
  const names = [...typers.keys()];  // the Map's keys as a normal array
  if (names.length === 0) {
    typingLine.textContent = "";
  } else if (names.length === 1) {
    typingLine.textContent = `${names[0]} is typing…`;
  } else if (names.length === 2) {
    typingLine.textContent = `${names[0]} and ${names[1]} are typing…`;
  } else {
    typingLine.textContent = "Several people are typing…";
  }
}
