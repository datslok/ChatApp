// The WebSocket to the chat server, and everything it tells us.
//
// useConnection() is a "hook": a function components call to get some state that React keeps
// for them. It opens the connection when the app starts, keeps it open (reconnecting after
// drops), and puts what the server sends into state, so every screen that shows it redraws
// by itself when it changes. It speaks exactly the same messages as the web page (core.js).
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { SOCKET_URL } from './config';

export function useConnection() {
  // "connecting", "online", "offline" (dropped: trying again) or "logged-out".
  const [status, setStatus] = useState('connecting');
  const [me, setMe] = useState(null);            // {id, username}
  const [channels, setChannels] = useState([]);  // the server's channels and headings, in order
  const [groups, setGroups] = useState([]);      // our group DMs
  const [friends, setFriends] = useState([]);    // our friends' ids (each has a DM with us)
  const [users, setUsers] = useState({});        // everyone, by id: {3: {id, name, ...}}
  const [emoji, setEmoji] = useState({});        // custom emoji names by id: {17: "pog"}
  const [unread, setUnread] = useState(new Set());  // chats with messages we haven't seen
  const [mentions, setMentions] = useState({});  // unread mentions of us per chat: {memes: 2}
  const [current, setCurrent] = useState(null);  // the chat we're reading, or null (the list)
  const [messages, setMessages] = useState(null);  // its messages, oldest first (null: loading)

  // Refs: values that live as long as the component but don't redraw anything when changed.
  // The socket's event handlers need the *latest* chat we're in; a ref always has it, while
  // state seen from inside an old function would be stuck at its value back then.
  const socket = useRef(null);
  const currentRef = useRef(null);
  const retryDelay = useRef(1000);
  const retryTimer = useRef(null);
  const firstUnread = useRef(true);  // the first "unread" after connecting is the whole list
  const loggedOut = useRef(false);   // the server said 4001: no point reconnecting until we log in

  function send(data) {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(data));
    }
  }

  // Tell the server whether the app is on screen, and that this is a phone: like the web
  // page's "looking", so we don't turn idle while using the app (and others see a phone).
  function sendLooking() {
    send({ type: 'looking', looking: AppState.currentState === 'active', mobile: true });
  }

  function handle(data) {
    switch (data.type) {
      case 'welcome':
        // max_text_length: the server's limit on a message, so the text box can use the same.
        setMe({ id: data.id, username: data.username, maxTextLength: data.max_text_length });
        break;
      case 'channels':
        setChannels(data.channels);
        break;
      case 'groups':
        setGroups(data.groups);
        break;
      case 'friends':
        setFriends(data.friends);
        break;
      case 'users': {
        const byId = {};
        for (const user of data.users) byId[user.id] = user;
        setUsers(byId);
        break;
      }
      case 'custom_emoji': {
        const names = {};
        for (const item of data.emoji) names[item.id] = item.name;
        setEmoji(names);
        break;
      }
      case 'unread': {
        // Right after connecting: every unread chat (replaces what we had). Later: one chat
        // that just got a new message (added). Never the chat we're reading: that's seen.
        const isFirst = firstUnread.current;
        firstUnread.current = false;
        const reading = currentRef.current;
        setUnread((old) => {
          const now = new Set(isFirst ? [] : old);
          for (const chat of data.channels) if (chat !== reading) now.add(chat);
          return now;
        });
        if (data.mentions) {
          setMentions((old) => {
            const now = isFirst ? { ...data.mentions } : { ...old, ...data.mentions };
            delete now[reading];
            return now;
          });
        }
        break;
      }
      case 'history':
        if (data.channel === currentRef.current) setMessages(data.messages);
        break;
      case 'message':
        if (data.channel === currentRef.current) {
          setMessages((old) => [...(old ?? []), data]);
        }
        break;
      case 'edited':
        if (data.channel === currentRef.current) {
          setMessages((old) => old?.map((message) => (message.id === data.message_id
            ? { ...message, text: data.text, edited_at: data.edited_at }
            : message)));
        }
        break;
      case 'deleted':
        if (data.channel === currentRef.current) {
          // Gone from the list, and replies to it now quote "a deleted message".
          setMessages((old) => old
            ?.filter((message) => message.id !== data.message_id)
            .map((message) => (message.reply?.id === data.message_id
              ? { ...message, reply: { id: data.message_id, deleted: true } }
              : message)));
        }
        break;
      case 'reactions':
        // A message's reactions changed (someone added or removed one): its whole new list.
        if (data.channel === currentRef.current) {
          setMessages((old) => old?.map((message) => (message.id === data.message_id
            ? { ...message, reactions: data.reactions }
            : message)));
        }
        break;
      // Everything else (reactions, calls, typing, ...) comes in later steps.
    }
  }

  function connect() {
    clearTimeout(retryTimer.current);
    loggedOut.current = false;
    const ws = new WebSocket(SOCKET_URL);  // Android sends the login cookie along by itself
    socket.current = ws;
    setStatus((old) => (old === 'online' ? 'online' : 'connecting'));

    ws.onopen = () => {
      retryDelay.current = 1000;  // it worked: next time start from 1 second again
      firstUnread.current = true;
      setStatus('online');
      sendLooking();
      // Back after a drop while reading a chat: join it again, which also sends its
      // history afresh (including whatever was said while we were gone).
      if (currentRef.current) send({ type: 'join', channel: currentRef.current });
    };

    ws.onmessage = (event) => handle(JSON.parse(event.data));

    ws.onclose = (event) => {
      if (socket.current !== ws) return;  // an old connection we already replaced
      if (event.code === 4001) {
        loggedOut.current = true;
        setStatus('logged-out');  // the server says we're not logged in
        return;
      }
      // Try again later, twice as long each time, at most 10 seconds (like the web page).
      setStatus('offline');
      retryTimer.current = setTimeout(connect, retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, 10000);
    };
  }

  // Runs once when the app starts; the function it returns runs when it closes.
  useEffect(() => {
    connect();
    // Android may cut the connection while the app is in the background. Coming back to the
    // app, reconnect at once instead of waiting for the next try.
    const watcher = AppState.addEventListener('change', (state) => {
      const ws = socket.current;
      const dropped = ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING;
      if (state === 'active' && dropped && !loggedOut.current) connect();
      sendLooking();
    });
    return () => {
      watcher.remove();
      clearTimeout(retryTimer.current);
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, []);

  // Start reading a chat: the server answers with its history, then sends its new messages.
  function openChat(key) {
    currentRef.current = key;
    setCurrent(key);
    setMessages(null);
    setUnread((old) => {
      const now = new Set(old);
      now.delete(key);
      return now;
    });
    setMentions((old) => {
      const now = { ...old };
      delete now[key];
      return now;
    });
    send({ type: 'join', channel: key });
  }

  // Back to the list: in no chat, so new messages anywhere count as unread again.
  function closeChat() {
    currentRef.current = null;
    setCurrent(null);
    setMessages(null);
    send({ type: 'join', channel: null });
  }

  // Writing. None of these change the screen themselves: the server answers everyone in the chat,
  // us included ("message", "reactions", "edited", "deleted"), and that's what we draw. So every
  // screen shows the same, and something the server refused never appears.
  function sendMessage(text, replyTo) {
    send({ type: 'message', text, reply_to: replyTo ?? null });
  }
  function react(messageId, emoji) {
    send({ type: 'react', message_id: messageId, emoji });  // again = take it back (a toggle)
  }
  function editMessage(messageId, text) {
    send({ type: 'edit', message_id: messageId, text });
  }
  function deleteMessage(messageId) {
    send({ type: 'delete', message_id: messageId });
  }

  return {
    status, me, channels, groups, friends, users, emoji, unread, mentions, current, messages,
    openChat, closeChat, sendMessage, react, editMessage, deleteMessage,
    reconnect: connect,  // after logging in
  };
}
