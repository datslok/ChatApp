// The WebSocket to the chat server, and everything it tells us.
//
// useConnection() is a "hook": a function components call to get some state that React keeps
// for them. It opens the connection when the app starts, keeps it open (reconnecting after
// drops), and puts what the server sends into state, so every screen that shows it redraws
// by itself when it changes. It speaks exactly the same messages as the web page (core.js).
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { SERVER, SOCKET_URL } from './config';
import { forgetThisPhone } from './notifications';
import { DEFAULT_APPEARANCE } from './theme';
import { limits } from './limits';

const PING_EVERY = 15000;     // ms between heartbeat pings while the app is on screen (see pingSent)
const PONG_WAIT = 6000;       // ms without an answer before the connection counts as dead
const SEND_GIVE_UP = 30000;   // ms before an unconfirmed message turns red (Retry, Delete)

// The newest emoji version each Android draws (its API level -> Unicode's emoji version): newer
// emoji would show as empty boxes, so the picker leaves them out. (The web page finds out by drawing
// each one on a canvas instead; an app can't.)
function newestEmojiVersion() {
  const api = Number(Platform.Version);
  if (api >= 37) return 17.0;
  if (api >= 36) return 16.0;  // Android 16
  if (api >= 35) return 15.1;
  if (api >= 34) return 15.0;
  if (api >= 33) return 14.0;
  if (api >= 31) return 13.1;
  if (api >= 30) return 13.0;
  if (api >= 29) return 12.0;
  return 11.0;
}

// emoji.json's groups without the emoji this phone can't draw (its "versions": {"17.0": [...], ...}).
function drawableGroups(data) {
  const newest = newestEmojiVersion();
  const tooNew = new Set();
  for (const [version, emoji] of Object.entries(data.versions ?? {})) {
    if (Number(version) > newest) for (const item of emoji) tooNew.add(item);
  }
  return data.groups
    .map((group) => ({ name: group.name, emoji: group.emoji.filter(([emoji]) => !tooNew.has(emoji)) }))
    .filter((group) => group.emoji.length > 0);  // (a group with nothing left goes)
}

export function useConnection() {
  // "connecting", "online", "offline" (dropped: trying again) or "logged-out".
  const [status, setStatus] = useState('connecting');
  const [me, setMe] = useState(null);            // {id, username}
  const [channels, setChannels] = useState([]);  // the server's channels and headings, in order (only ours)
  // false for someone with a limited role: no Lounge. null until the first "channels" (App.js waits for it).
  const [lounge, setLounge] = useState(null);
  const [groups, setGroups] = useState([]);      // our group DMs
  const [groupsKnown, setGroupsKnown] = useState(false);  // the first "groups" has come (App.js waits for it)
  const [friends, setFriends] = useState([]);    // our friends' ids (each has a DM with us)
  const [incoming, setIncoming] = useState([]);  // ids of people who sent us a friend request
  const [outgoing, setOutgoing] = useState([]);  // ids of people we sent one to
  const [blocked, setBlocked] = useState([]);    // ids of people we blocked
  const [users, setUsers] = useState({});        // everyone, by id: {3: {id, name, ...}}
  const [roles, setRoles] = useState([]);        // the server's roles, top first: [{id, name, colour}]
  const [myPresence, setMyPresence] = useState('online');  // the status we chose (others may see another)
  // Settings → Appearance as the server keeps it (null: not heard yet; App.js applies it).
  const [appearance, setAppearance] = useState(null);
  const [emoji, setEmoji] = useState({});        // custom emoji by id: {17: {id, name, file, owner_id}}
  // Every Unicode emoji, for the picker and ":" suggestions: the server's /emoji.json, fetched once
  // ({groups: [{name, emoji: [["😀", "grinning face"], ...]}, ...]}). null until it has come.
  const [emojiGroups, setEmojiGroups] = useState(null);
  // Who's typing in the chat we're in, by name: each disappears 3 s after their last "typing".
  const [typing, setTyping] = useState([]);
  const typingTimers = useRef({});   // name -> its timer
  const lastTypingSent = useRef(0);  // when we last said we're typing (at most every 2 s)
  const [unread, setUnread] = useState(new Set());  // chats with messages we haven't seen
  const [mentions, setMentions] = useState({});  // unread mentions of us per chat: {memes: 2}
  const [current, setCurrent] = useState(null);  // the chat we're reading, or null (the list)
  const [messages, setMessages] = useState(null);  // its messages, oldest first (null: loading)
  // Where we had stopped reading it (the history's "last_read", a message id): the red NEW line
  // goes above the first message after it. null: no line.
  const [lastRead, setLastRead] = useState(null);
  // Are there older messages than the ones we have (the server's "more": it sent a full batch)?
  const [more, setMore] = useState(false);
  const loadingOlder = useRef(false);  // asked for older ones, waiting for them
  const [mutedChats, setMutedChats] = useState(new Set());  // chats we muted: no unread dot, faded
  // DMs and groups pinned to the top of the list, and each one's newest message id (the list is sorted
  // by it, newest first): the server's "Recent and pinned DMs".
  const [pinnedChats, setPinnedChats] = useState(new Set());
  const [chatActivity, setChatActivity] = useState({});
  // The open chat's pinned messages while the 📌 list is open (null: on their way), and whether it
  // is open (a ref: the socket's handlers need it, to ask again when a pin changes).
  const [pins, setPins] = useState(null);
  const pinsOpen = useRef(false);
  // The chat info screen while it's open (ChatInfoScreen.js): {batch(data), news(kind, data)}, told about
  // its batches ("chat_info") and about changes in the chat that may change its tab. A ref, set by
  // watchChatInfo: the socket's handlers call it, and nothing here needs to redraw for it.
  const chatInfoWatcher = useRef(null);
  // The newest search's answer, {ask, results}: ask numbers our searches (search() returns it), so
  // the search screen can tell an older search's answer (typing fast) from the one it waits for.
  const [searchResults, setSearchResults] = useState(null);
  const searchAsk = useRef(0);
  // "This chat already has 100 pinned messages": {max} (a new object each time, so it shows again).
  const [pinsFull, setPinsFull] = useState(null);
  // Who's in each voice channel: {lounge: [{id, muted, deafened}]} (the server's "voice_members").
  const [voiceMembers, setVoiceMembers] = useState({});
  // The calls going on in our DMs and groups: {"dm:3:7": [{id, muted, deafened}]} ("dm_call"; an empty
  // list means that call is over, so it's left out).
  const [dmCalls, setDmCalls] = useState({});
  // voice.js listens here for ringing: "call", "call_answered" and "call_ended" go to it as they come.
  const callListener = useRef(null);
  // notifications.js listens here: a DM or mention in another chat (the "notify" in "unread": the ping).
  const notifyListener = useRef(null);
  // Where we are in voice, as we last told the server ({room, muted, deafened}): told again after
  // every reconnect, since the server forgets us when the connection drops.
  const voiceState = useRef({ room: null, muted: false, deafened: false });

  // Refs: values that live as long as the component but don't redraw anything when changed.
  // The socket's event handlers need the *latest* chat we're in; a ref always has it, while
  // state seen from inside an old function would be stuck at its value back then.
  const socket = useRef(null);
  const currentRef = useRef(null);
  const retryDelay = useRef(1000);
  const retryTimer = useRef(null);
  const firstUnread = useRef(true);  // the first "unread" after connecting is the whole list
  const loggedOut = useRef(false);   // the server said 4001: no point reconnecting until we log in
  // The heartbeat: a bad network can kill the connection without either end hearing (no "close" ever
  // comes, and Android's WebSocket never times out waiting), and messages sent into it are lost. So we
  // ping every PING_EVERY ms while on screen (and at once after sending something, or coming back to
  // the app); anything at all from the server counts as the answer. None within PONG_WAIT: it's dead,
  // so we connect again straight away.
  const pingSent = useRef(null);   // when our unanswered ping went out, or null
  const lastPing = useRef(0);
  const myId = useRef(null);            // our own id (from "welcome"), for the socket's handlers
  const newWhileAway = useRef(false);   // this time away already moved the NEW line (see "message")

  // The outbox: messages we sent that the server hasn't confirmed yet, each {nonce (its tag), chat, text,
  // replyTo, file, failed, since}. ChatScreen draws the open chat's at the bottom, faded ("Sending…"), or
  // red with Retry and Delete once failed (no answer in SEND_GIVE_UP ms, or the server said no). They're
  // sent again after every reconnect; the server remembers the tags, so nothing is posted twice.
  const [outbox, setOutbox] = useState([]);
  const outboxRef = useRef([]);  // (the same, for the socket's handlers, which need the latest)
  function changeOutbox(change) {
    outboxRef.current = change(outboxRef.current);
    setOutbox(outboxRef.current);
  }

  // True if it went out (false: not connected right now).
  function send(data) {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(data));
    return true;
  }

  // Tell the server whether the app is on screen, and that this is a phone: like the web
  // page's "looking", so we don't turn idle while using the app (and others see a phone). android:
  // the app, not a phone's browser (the server remembers each message's device for Chattus, who then
  // explains the app's way to a setting: server.py, device_of).
  function sendLooking() {
    send({ type: 'looking', looking: AppState.currentState === 'active', mobile: true, android: true });
  }

  function handle(data) {
    switch (data.type) {
      case 'sent':
        // {"type": "sent", "nonce"}: a message of ours is saved (also when we're in another chat by now).
        changeOutbox((old) => old.filter((item) => item.nonce !== data.nonce));
        break;
      case 'not_sent':
        // The server refused it (no longer allowed in that chat, a file already sent): it turns red.
        changeOutbox((old) => old.map((item) => (item.nonce === data.nonce ? { ...item, failed: true } : item)));
        break;
      case 'welcome':
        myId.current = data.id;
        Object.assign(limits, data.limits);  // the server's limits (limits.js)
        // max_text_length: the server's limit on a message, so the text box can use the same.
        // season: the seasonal easter egg ({name, emoji or image, video}), or null (Sidebar.js).
        // phonePush: the server can send this app push notifications (it has Firebase's key).
        setMe({
          id: data.id, username: data.username, maxTextLength: data.max_text_length, season: data.season,
          phonePush: data.phone_push === true,
        });
        setMyPresence(data.presence);
        setAppearance(data.appearance ?? DEFAULT_APPEARANCE);  // (null: never changed: the defaults)
        break;
      case 'appearance':
        // Changed in Settings, here or on another device (the server sends it to all our devices).
        setAppearance(data.appearance);
        break;
      case 'my_presence':
        setMyPresence(data.presence);
        break;
      case 'roles':
        setRoles(data.roles);
        break;
      case 'channels':
        setChannels(data.channels);
        setLounge(data.lounge !== false);
        break;
      case 'groups':
        setGroups(data.groups);
        setGroupsKnown(true);
        break;
      case 'friends':
        // Sent at connect, and again after every change (ours or theirs) to any of the three.
        setFriends(data.friends);
        setIncoming(data.incoming);
        setOutgoing(data.outgoing);
        break;
      case 'blocks':
        setBlocked(data.blocked);
        break;
      case 'mutes':
        // Our muted chats (at connect, and after muting or unmuting here or on another device).
        setMutedChats(new Set(data.channels));
        break;
      case 'pinned_chats':
        // Our pinned DMs and groups (at connect, and after pinning or unpinning here or elsewhere).
        setPinnedChats(new Set(data.channels));
        break;
      case 'chat_activity':
        // {chats: {key: newest message id}}: all our DMs and groups at connect, then one per new message.
        setChatActivity((old) => {
          const next = { ...old };
          for (const [key, id] of Object.entries(data.chats)) next[key] = Math.max(id, old[key] ?? 0);
          return next;
        });
        break;
      case 'pins':
        if (pinsOpen.current && data.channel === currentRef.current) setPins(data.messages);
        break;
      case 'pins_full':
        setPinsFull({ max: data.max });
        break;
      case 'chat_info':
        // A batch of the open chat's media, links or files (the server's "Chat info").
        if (data.channel === currentRef.current) chatInfoWatcher.current?.batch(data);
        break;
      case 'search_results':
        // (From any chat: not checked against the one we're in.)
        if (data.ask === searchAsk.current) setSearchResults({ ask: data.ask, results: data.results });
        break;
      case 'users': {
        const byId = {};
        for (const user of data.users) byId[user.id] = user;
        setUsers(byId);
        break;
      }
      case 'custom_emoji': {
        const byId = {};
        for (const item of data.emoji) byId[item.id] = item;
        setEmoji(byId);
        break;
      }
      case 'typing':
        // {"type": "typing", "channel", "name"}: someone else in this chat is typing.
        if (data.channel === currentRef.current) showTyping(data.name);
        break;
      case 'preview':
        // A link's preview card, a moment after its message (the server fetched the page meanwhile).
        if (data.channel === currentRef.current) {
          setMessages((old) => old?.map((message) => (message.id === data.message_id
            ? { ...message, preview: data.preview }
            : message)));
          chatInfoWatcher.current?.news('preview', data);
        }
        break;
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
        if (data.notify) notifyListener.current?.(data.notify);
        break;
      }
      case 'history':
        if (data.channel === currentRef.current) {
          setMessages(data.messages);
          setMore(data.more);
          loadingOlder.current = false;
          // A line only if something after it is new (never opened before: no line either).
          const newest = data.messages[data.messages.length - 1];
          setLastRead(data.last_read !== null && newest && newest.id > data.last_read ? data.last_read : null);
        }
        break;
      case 'older':
        // The 50 before our oldest, oldest first: they go in front.
        if (data.channel === currentRef.current) {
          setMessages((old) => [...data.messages, ...(old ?? [])]);
          setMore(data.more);
        }
        loadingOlder.current = false;
        break;
      case 'pinned':
        if (data.channel === currentRef.current) {
          setMessages((old) => old?.map((message) => (message.id === data.message_id
            ? { ...message, pinned: data.pinned }
            : message)));
          if (pinsOpen.current) send({ type: 'pins' });  // the 📌 list is open: ask for it afresh
          chatInfoWatcher.current?.news('pinned', data);
        }
        break;
      case 'message':
        // One of ours from the outbox (its tag): the real one replaces the faded copy, in the same redraw.
        if (data.nonce) changeOutbox((old) => old.filter((item) => item.nonce !== data.nonce));
        if (data.channel === currentRef.current) {
          // The NEW line, live (the web page's): we wrote something (here or on another device): caught
          // up, it goes. The first message while the app is out of sight: the line moves above it, so
          // coming back shows where we left off (ids only grow: "after id - 1" is this one and what follows).
          if (data.user_id === myId.current) {
            setLastRead(null);
          } else if (AppState.currentState !== 'active' && !newWhileAway.current) {
            setLastRead(data.id - 1);
            newWhileAway.current = true;
          }
          setMessages((old) => [...(old ?? []), data]);
          stopTyping(data.name);  // their message is here: they're done typing it
          chatInfoWatcher.current?.news('message', data);
        }
        break;
      case 'edited':
        if (data.channel === currentRef.current) {
          setMessages((old) => old?.map((message) => (message.id === data.message_id
            ? { ...message, text: data.text, edited_at: data.edited_at }
            : message)));
          chatInfoWatcher.current?.news('edited', data);
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
          if (pinsOpen.current) send({ type: 'pins' });  // (it may have been pinned)
          chatInfoWatcher.current?.news('deleted', data);
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
      case 'voice_members':
        setVoiceMembers(data.rooms);
        break;
      case 'dm_call':
        setDmCalls((old) => {
          const now = { ...old };
          if (data.members.length) now[data.channel] = data.members;
          else delete now[data.channel];
          return now;
        });
        break;
      case 'call':           // someone is calling us (voice.js rings)
      case 'call_answered':  // our call was answered, or we answered on another device
      case 'call_ended':     // a ringing call is over: declined, no answer, cancelled
        callListener.current?.(data);
        break;
    }
  }

  // ----- Typing (the web page's people.js, "Typing")

  function showTyping(name) {
    clearTimeout(typingTimers.current[name]);
    typingTimers.current[name] = setTimeout(() => stopTyping(name), 3000);
    setTyping((old) => (old.includes(name) ? old : [...old, name]));
  }

  function stopTyping(name) {
    clearTimeout(typingTimers.current[name]);
    delete typingTimers.current[name];
    setTyping((old) => old.filter((other) => other !== name));
  }

  function clearTyping() {
    for (const timer of Object.values(typingTimers.current)) clearTimeout(timer);
    typingTimers.current = {};
    setTyping([]);
  }

  // Called as we type: tell the others, at most every 2 seconds.
  function sendTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current > 2000) {
      lastTypingSent.current = now;
      send({ type: 'typing' });
    }
  }

  function connect() {
    clearTimeout(retryTimer.current);
    loggedOut.current = false;
    pingSent.current = null;
    const ws = new WebSocket(SOCKET_URL);  // Android sends the login cookie along by itself
    socket.current = ws;
    setStatus((old) => (old === 'online' ? 'online' : 'connecting'));

    ws.onopen = () => {
      retryDelay.current = 1000;  // it worked: next time start from 1 second again
      firstUnread.current = true;
      setStatus('online');
      sendLooking();
      // (The calls going on come again with "dm_call" at connect: start from nothing.)
      setDmCalls({});
      // In a call when the connection dropped: the server took us out of it, so say again where we are.
      if (voiceState.current.room) send({ type: 'voice', ...voiceState.current });
      // Back after a drop while reading a chat: join it again, which also sends its
      // history afresh (including whatever was said while we were gone).
      if (currentRef.current) send({ type: 'join', channel: currentRef.current });
      // And whatever we sent that wasn't confirmed: once more (the server skips what it already has).
      for (const item of outboxRef.current) if (!item.failed) sendFromOutbox(item);
    };

    ws.onmessage = (event) => {
      if (socket.current === ws) pingSent.current = null;  // anything from the server: it's alive
      handle(JSON.parse(event.data));
    };

    ws.onclose = (event) => {
      if (socket.current !== ws) return;  // an old connection we already replaced
      if (event.code === 4001) {
        loggedOut.current = true;
        setStatus('logged-out');  // the server says we're not logged in
        return;
      }
      // Try again later, twice as long each time, at most 5 seconds (a phone's bad patch is often short).
      setStatus('offline');
      retryTimer.current = setTimeout(connect, retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, 5000);
    };
  }

  // Ask the server for a sign of life, unless we're already waiting for one (see pingSent).
  function checkConnection() {
    if (pingSent.current === null && send({ type: 'ping' })) {
      pingSent.current = Date.now();
      lastPing.current = pingSent.current;
    }
  }

  // Every 2 seconds: a ping unanswered too long means a dead connection (connect again now and drop the
  // old one; its "close", whenever it comes, is ignored); time for the next ping; outbox messages waiting too long.
  function heartbeat() {
    const now = Date.now();
    if (pingSent.current !== null && now - pingSent.current > PONG_WAIT) {
      const dead = socket.current;
      connect();
      dead?.close();
    } else if (now - lastPing.current > PING_EVERY && AppState.currentState === 'active') {
      checkConnection();
    }
    if (outboxRef.current.some((item) => !item.failed && now - item.since > SEND_GIVE_UP)) {
      changeOutbox((old) => old.map((item) => (!item.failed && now - item.since > SEND_GIVE_UP ? { ...item, failed: true } : item)));
    }
  }

  // Runs once when the app starts; the function it returns runs when it closes.
  useEffect(() => {
    connect();
    // Unicode's emoji list, once (it changes only when the server's tools/make_emoji_json.py runs).
    // (no-cache: ask the server each time instead of using a copy up to a day old, which is how
    // long the server lets it be kept: once per start, a new list shows at once.)
    fetch(`${SERVER}/emoji.json`, { headers: { 'Cache-Control': 'no-cache' } })
      .then((response) => response.json()).then((data) => setEmojiGroups(drawableGroups(data)))
      .catch(() => {});  // (no picker list then; everything else works)
    // Android may cut the connection while the app is in the background. Coming back to the
    // app, reconnect at once instead of waiting for the next try.
    // And one that looks open may have died meanwhile: ask (a ping from before going away doesn't count).
    const watcher = AppState.addEventListener('change', (state) => {
      const ws = socket.current;
      const dropped = ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING;
      if (state === 'active' && dropped && !loggedOut.current) connect();
      sendLooking();
      if (state === 'active') {
        newWhileAway.current = false;  // back: the next time away gets a line of its own
        pingSent.current = null;
        checkConnection();
      }
    });
    const beat = setInterval(heartbeat, 2000);
    return () => {
      watcher.remove();
      clearInterval(beat);
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
    setLastRead(null);
    setMore(false);
    loadingOlder.current = false;
    clearTyping();
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

  // Log out (your popup's Log out): the server forgets this login and tells Android to drop the cookie;
  // then the connection closes for good and App.js shows the login screen. me goes back to null, so
  // logging in as someone else shows nothing of this account while the new "welcome" is on its way.
  async function logout() {
    await forgetThisPhone();  // (no more of this account's pushes here)
    await fetch(`${SERVER}/logout`, { method: 'POST' }).catch(() => {});
    loggedOut.current = true;
    currentRef.current = null;
    const ws = socket.current;
    socket.current = null;  // (so its closing isn't taken for a dropped connection)
    ws?.close();
    setMe(null);
    setCurrent(null);
    setMessages(null);
    changeOutbox(() => []);  // (unsent messages were this account's)
    setStatus('logged-out');
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
  // `file`: an uploaded file's id (a picture we picked, a GIF from /gifs/send) to send with it.
  // It goes into the outbox (see outbox), so it's never lost: true, unless no chat is open.
  function sendMessage(text, replyTo, file) {
    if (!currentRef.current) return false;
    const item = {
      nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),  // (random enough to be ours alone)
      chat: currentRef.current, text, replyTo: replyTo ?? null, file: file ?? null, failed: false, since: Date.now(),
    };
    changeOutbox((old) => [...old, item]);
    sendFromOutbox(item);
    setLastRead(null);  // we wrote something: caught up, the NEW line goes (like the web page)
    lastTypingSent.current = 0;  // so the next message's typing is told at once
    return true;
  }
  // (Naming its chat: by the time it's sent again we may be in another one.) Then make sure it went somewhere alive.
  function sendFromOutbox(item) {
    const sent = send({
      type: 'message', channel: item.chat, text: item.text, reply_to: item.replyTo, file: item.file, nonce: item.nonce,
    });
    if (sent) checkConnection();
  }
  // A failed one's Retry and Delete.
  function retryMessage(nonce) {
    const item = outboxRef.current.find((other) => other.nonce === nonce);
    if (!item) return;
    const again = { ...item, failed: false, since: Date.now() };
    changeOutbox((old) => old.map((other) => (other.nonce === nonce ? again : other)));
    sendFromOutbox(again);
  }
  function discardMessage(nonce) {
    changeOutbox((old) => old.filter((item) => item.nonce !== nonce));
  }
  // Scrolled up to the oldest message we have: ask for the 50 before it (once at a time).
  function loadOlder() {
    if (!more || loadingOlder.current || !messages?.length) return;
    loadingOlder.current = true;
    send({ type: 'older', before: messages[0].id });
  }
  function pin(messageId, pinned) {
    send({ type: 'pin', message_id: messageId, pinned });  // ("pinned" comes back to everyone)
  }
  // Our status: online, idle, dnd or invisible. The server tells all our devices ("my_presence") and
  // everyone else ("users"); that's what changes the screen.
  function setPresence(presence) {
    send({ type: 'presence', presence });
  }
  // Mute or unmute a chat. The server answers all our devices with the new list ("mutes").
  function mute(key, muted) {
    send({ type: 'mute', channel: key, muted });
  }
  function pinChat(key, pinned) {
    send({ type: 'pin_chat', channel: key, pinned });
  }
  // The 📌 list of the chat we're in: asked when it opens, and again whenever a pin changes while
  // it's open (see "pinned" and "deleted" above). The answer comes as `pins`.
  function openPins() {
    pinsOpen.current = true;
    setPins(null);
    send({ type: 'pins' });
  }
  function closePins() {
    pinsOpen.current = false;
    setPins(null);
  }
  // The chat info screen (ChatInfoScreen.js): it gives its watcher while it's open (the returned function
  // takes it away again), and asks for a tab's batches: tab "media", "links" or "files", before a message
  // id or null for the newest. The answers go to watcher.batch.
  function watchChatInfo(watcher) {
    chatInfoWatcher.current = watcher;
    return () => {
      if (chatInfoWatcher.current === watcher) chatInfoWatcher.current = null;
    };
  }
  function askChatInfo(tab, before) {
    send({ type: 'chat_info', tab, before });
  }
  // Search: words, a chat's key or null (everywhere we can see), a person's id or null (anyone).
  // Returns this search's number; its answer comes as `searchResults` with the same `ask`.
  // (Any answer still on its way for an earlier search is from then on ignored.)
  function search(query, chat, from) {
    searchAsk.current += 1;
    send({ type: 'search', query, channel: chat, from, ask: searchAsk.current });
    return searchAsk.current;
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

  // Calls (voice.js). Where we are in voice (room: "lounge", a DM's or group's key, or null), and
  // whether we're muted or deafened: the server tells everyone who's where ("voice_members", "dm_call").
  function sendVoice(state) {
    voiceState.current = state;
    send({ type: 'voice', ...state });
  }
  // Ring the others in a DM or group; answer a call ringing for us; hang up our own call before anyone
  // answered (stops their ringing).
  function ring(chat) {
    send({ type: 'call', channel: chat });
  }
  function answerCall(chat, accept) {
    send({ type: 'call_answer', channel: chat, accept });
  }
  function cancelCall(chat) {
    send({ type: 'call_cancel', channel: chat });
  }

  // Friends and blocking go through the server's /friends/... addresses (like the web page), not
  // the WebSocket. "request", "accept", "remove" (decline, cancel or unfriend), "block", "unblock".
  // The server then sends both people a fresh "friends" (or "blocks"), which redraws the lists;
  // so this only returns the error to show, or null if it worked.
  async function friendAction(action, userId) {
    try {
      const response = await fetch(`${SERVER}/friends/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      if (response.ok) return null;
      const answer = await response.json().catch(() => ({}));
      return typeof answer.detail === 'string' ? answer.detail : 'Something went wrong.';
    } catch {
      return "Couldn't reach the server.";
    }
  }

  return {
    status, me, myPresence, appearance, channels, lounge, groups, groupsKnown, friends, incoming, outgoing, blocked, users, roles, emoji,
    emojiGroups, unread, mentions, current, messages, lastRead, more, typing, mutedChats, pinnedChats, chatActivity, pins, pinsFull,
    searchResults, voiceMembers, dmCalls, callListener, notifyListener,
    outbox, retryMessage, discardMessage,
    openChat, closeChat, loadOlder, sendMessage, sendTyping, react, pin, editMessage, deleteMessage,
    friendAction, mute, pinChat, openPins, closePins, watchChatInfo, askChatInfo, search, setPresence, logout, sendVoice, ring, answerCall, cancelCall,
    reconnect: connect,  // after logging in
  };
}
