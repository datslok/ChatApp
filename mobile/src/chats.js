// Chats' keys and names, the way the web page writes them.

// A DM's key is "dm:" + the two user ids, the smaller first (the server's rule): "dm:3:7".
export function dmKey(myId, theirId) {
  return `dm:${Math.min(myId, theirId)}:${Math.max(myId, theirId)}`;
}

// The other person in a DM ("dm:3:7" seen by 3 -> 7), or null if it isn't a DM.
export function dmPartner(key, myId) {
  if (!key?.startsWith('dm:')) return null;
  return key.slice(3).split(':').map(Number).find((id) => id !== myId) ?? null;
}

// May this person see this channel? The server's rule (server.py, "Who sees which channel"), like the
// web page's seesChannel: a private channel comes with everyone who sees it ("members"; its roles may be
// hidden from us), an open one is for everyone not limited, and the owner sees all. (Only for drawing.)
export function seesChannel(user, channel) {
  if (user.owner) return true;
  if (channel.private) return (channel.members ?? []).includes(user.id);
  return !user.limited;
}

// A group's people: its members without the bots (every bot is in every group, see server.py).
export function groupPeople(group, users) {
  return group.members.filter((id) => !users[id]?.bot);
}

// A group's name, or (without one) the other people's names ("kari, ola"), like the web page's groupLabel.
export function groupName(group, users, myId) {
  if (group.name) return group.name;
  const others = groupPeople(group, users).filter((id) => id !== myId).map((id) => users[id]?.name ?? 'someone');
  return others.length ? others.join(', ') : 'Just you';
}

// The Direct messages list's order, like the web page's sortedDmKeys (the server's "Recent and pinned
// DMs"): pinned ones first, then by their newest message, newest first; chats without any messages last,
// alphabetically. Groups and DMs mixed. The keys, in order.
export function sortedDmKeys({ groups, friends, users, me, pinnedChats, chatActivity }) {
  const friendKeys = friends.map((id) => users[id]).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((user) => dmKey(me.id, user.id));
  // (sort keeps the order among equals: chats without messages stay alphabetical.)
  return [...groups.map((group) => group.key), ...friendKeys].sort((a, b) => (pinnedChats.has(b) - pinnedChats.has(a))
    || ((chatActivity[b] ?? 0) - (chatActivity[a] ?? 0)));
}

// What a chat is called in the top bar and the text box: "#memes", "@kari", or a group's name
// (the web page's labels: "Message #memes", "Message @kari").
export function chatLabel(key, { channels, groups, users, me }) {
  const partner = dmPartner(key, me?.id);
  if (partner !== null) return '@' + (users[partner]?.name ?? '?');
  const group = groups.find((g) => g.key === key);
  if (group) return groupName(group, users, me?.id);
  return '#' + (channels.find((c) => c.key === key)?.name ?? key);
}
