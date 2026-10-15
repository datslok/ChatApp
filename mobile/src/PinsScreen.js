// 📌 in the chat's bar: its pinned messages, the latest pinned first, each with Jump and Unpin
// (the web page's "Pinned messages"). Asked from the server when it opens; connection.js asks
// again whenever a pin changes or a message is deleted while it's open, so it stays up to date.
import { useEffect } from 'react';
import { ScrollView, Text } from 'react-native';
import { CardButton, MessageCard, Popup, styles } from './MessageCard';

// onJump(messageId): close this and go to the message.
export default function PinsScreen({ connection, onJump, onClose }) {
  const { pins } = connection;

  // Ask when it opens; when it closes, stop following the pins.
  useEffect(() => {
    connection.openPins();
    return connection.closePins;
  }, []);

  let empty = null;
  if (pins === null) empty = 'Loading…';
  // (The web page says "Hover over a message"; here it's a long press.)
  else if (pins.length === 0) empty = 'Nothing pinned here yet. Press and hold a message and choose Pin to pin it.';

  return (
    <Popup icon="pin" title="Pinned messages" onClose={onClose}>
      {empty ? <Text style={styles.empty}>{empty}</Text> : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listInside}>
          {pins.map((message) => (
            <MessageCard key={message.id} message={message} connection={connection}>
              <CardButton label="Jump" onPress={() => onJump(message.id)} />
              <CardButton label="Unpin" secondary onPress={() => connection.pin(message.id, false)} />
            </MessageCard>
          ))}
        </ScrollView>
      )}
    </Popup>
  );
}
