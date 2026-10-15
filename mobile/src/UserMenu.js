// The user menu (the web page's right-click menu, people.js userMenuItems): a long press on someone's
// picture or name opens it, as a sheet from the bottom. What's in it depends on how we stand with them.
// (Call comes with calls.)
import { Alert } from 'react-native';
import { askToSetAdmin } from './AdminSettings';
import { mayBan } from './BanDialog';
import { Sheet, SheetItem, SheetLine } from './Sheet';
import { dmKey } from './chats';
import { askToBlock, askToRemove } from './friends';

// onProfile(id), onOpen(key): open their profile, or a chat. onMention: put "@name " in the text box
// (null on the People page, where there's none). onEditProfile: Settings → Profile (our own menu).
// onBan(id): the ban popup. onClose: close the menu.
export default function UserMenu({ connection, userId, onProfile, onOpen, onMention, onEditProfile, onBan, onClose }) {
  const { users, me, friends, incoming, outgoing, blocked, mutedChats } = connection;
  const user = users[userId];
  if (!user) return null;

  // Every choice closes the menu first, then does its thing.
  const choose = (action) => () => {
    onClose();
    action();
  };
  // A friend action; what went wrong (if anything) in a small box, as the menu has gone.
  async function act(action, id) {
    const problem = await connection.friendAction(action, id);
    if (problem) Alert.alert('', problem);
  }

  const items = [<SheetItem key="profile" label="Profile" onPress={choose(() => onProfile(userId))} />];
  if (userId === me.id) {
    items.push(<SheetItem key="edit" label="Edit profile" onPress={choose(onEditProfile)} />);
    return <Sheet title={user.name} onClose={onClose}>{items}</Sheet>;
  }

  // The admin part, under a line of its own (the web page's adminMenuItems): Make admin / Remove admin
  // for the owner (asked first, like Settings → Admin → Admins), and Ban… for admins.
  const adminItems = [];
  if (users[me.id]?.owner && !user.bot && !user.owner) {
    adminItems.push(
      <SheetItem
        key="admin" label={user.admin ? 'Remove admin' : 'Make admin'}
        onPress={choose(() => askToSetAdmin(user, !user.admin, (problem) => Alert.alert('', problem)))}
      />,
    );
  }
  if (mayBan(user, users, me)) {
    adminItems.push(<SheetItem key="ban" label="Ban…" danger onPress={() => onBan(userId)} />);
  }
  if (adminItems.length) adminItems.unshift(<SheetLine key="adminLine" />);
  if (onMention) items.push(<SheetItem key="mention" label="Mention" onPress={choose(() => onMention(user))} />);

  if (blocked.includes(userId)) {
    items.push(<SheetLine key="line" />);
    items.push(<SheetItem key="unblock" label="Unblock" onPress={choose(() => act('unblock', userId))} />);
    return <Sheet title={user.name} onClose={onClose}>{items}{adminItems}</Sheet>;
  }

  const dm = dmKey(me.id, userId);
  const isFriend = friends.includes(userId);
  if (isFriend) items.push(<SheetItem key="message" label="Message" onPress={choose(() => onOpen(dm))} />);
  items.push(<SheetLine key="line" />);
  if (isFriend) {
    if (!user.bot) {
      items.push(<SheetItem key="remove" label="Remove friend" onPress={choose(() => askToRemove(user, act))} />);
    }
    // Mute or unmute our DM with them (the same as the bell there). Not with an admin: they can't be muted.
    if (!user.admin) {
      const muted = mutedChats.has(dm);
      items.push(
        <SheetItem key="mute" label={muted ? 'Unmute DM' : 'Mute DM'} onPress={choose(() => connection.mute(dm, !muted))} />,
      );
    }
  } else if (incoming.includes(userId)) {
    items.push(<SheetItem key="accept" label="Accept friend request" onPress={choose(() => act('accept', userId))} />);
    items.push(<SheetItem key="decline" label="Decline friend request" onPress={choose(() => act('remove', userId))} />);
  } else if (outgoing.includes(userId)) {
    items.push(<SheetItem key="cancel" label="Cancel friend request" onPress={choose(() => act('remove', userId))} />);
  } else {
    items.push(<SheetItem key="add" label="Add friend" onPress={choose(() => act('request', userId))} />);
  }
  if (!user.admin && !user.bot) {  // (admins and bots can't be blocked)
    items.push(<SheetItem key="block" label="Block" danger onPress={choose(() => askToBlock(user, act))} />);
  }
  return <Sheet title={user.name} onClose={onClose}>{items}{adminItems}</Sheet>;
}
