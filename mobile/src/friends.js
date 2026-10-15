// How we stand with someone, and what we can do about it: the web page's makeFriendButtons (the
// People page and the profile) and the friend part of its user menu. The server checks every rule
// again; these only decide which buttons to show.
import { Alert } from 'react-native';
import { dmKey } from './chats';

// "Block kari?": asked first, as on the web page. act(action, userId) does it.
export function askToBlock(user, act) {
  Alert.alert(
    `Block ${user.name}?`,
    "You stop being friends, and their messages are hidden for you. They aren't told.",
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: () => act('block', user.id) },
    ],
  );
}

export function askToRemove(user, act) {
  Alert.alert(
    `Remove ${user.name} as a friend?`,
    "Your DM is kept, hidden, until you're friends again.",
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => act('remove', user.id) },
    ],
  );
}

// The buttons for one person: [{label, onPress, secondary}], blue for the main one, grey
// ("secondary") for the rest. act(action, userId): connection.friendAction plus showing what went
// wrong; onOpen(key): open a chat (App.js's go).
export function friendButtons(user, connection, act, onOpen) {
  const { friends, incoming, outgoing, blocked, me } = connection;
  const buttons = [];
  const add = (label, onPress, secondary) => buttons.push({ label, onPress, secondary });
  if (blocked.includes(user.id)) {
    add('Unblock', () => act('unblock', user.id), true);
    return buttons;  // nothing else until they're unblocked: no friend request, no DM
  }
  if (friends.includes(user.id)) {
    add('Message', () => onOpen(dmKey(me.id, user.id)));
    if (!user.bot) add('Remove', () => act('remove', user.id), true);  // bots are everyone's friend
  } else if (incoming.includes(user.id)) {
    add('Accept', () => act('accept', user.id));
    add('Decline', () => act('remove', user.id), true);
  } else if (outgoing.includes(user.id)) {
    add('Cancel request', () => act('remove', user.id), true);
  } else {
    add('Add friend', () => act('request', user.id));
  }
  // Block: never admins (the chat's rule) or bots.
  if (!user.admin && !user.bot) add('Block', () => askToBlock(user, act), true);
  return buttons;
}
