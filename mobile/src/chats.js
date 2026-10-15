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

// What a chat is called in the top bar and the text box: "#memes", "@kari", or a group's name
// (the web page's labels: "Message #memes", "Message @kari").
export function chatLabel(key, { channels, groups, users, me }) {
  const partner = dmPartner(key, me?.id);
  if (partner !== null) return '@' + (users[partner]?.name ?? '?');
  const group = groups.find((g) => g.key === key);
  if (group) return groupName(group, users, me?.id);
  return '#' + (channels.find((c) => c.key === key)?.name ?? key);
}
