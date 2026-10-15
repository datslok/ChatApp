// Settings → Emoji (the web page's settings.js, "custom emoji"): your own custom emoji, each with
// Replace (a new picture, same name: messages and reactions with it show the new one) and Delete, and
// a name box with "Choose picture…" for a new one. Admins also see everyone else's, to replace or delete.
// Pictures go through the picture editor (PictureEditor.js), like the web page's. The server sends
// everyone the new list ("custom_emoji") after every change, which redraws this.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { deleteJson } from './api';
import { uploadPicture } from './files';
import { CustomEmoji } from './MessageText';
import PictureEditor, { pickPicture } from './PictureEditor';
import { Button, Field, Form, Help, Status, Title } from './SettingsParts';
import { useStyles } from './theme';

const MAX_CUSTOM_EMOJI = 12;  // as the server's
const NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;

// One emoji: its picture, ":name:" (and whose, for someone else's), Replace and Delete.
function EmojiRow({ item, owner, onReplace, onDelete }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.item}>
      <CustomEmoji item={item} size={32} />
      <Text style={styles.name} numberOfLines={1}>:{item.name}:{owner ? ` (${owner})` : ''}</Text>
      <Button label="Replace" small secondary onPress={onReplace} />
      <Button label="Delete" small secondary onPress={onDelete} />
    </View>
  );
}

export default function EmojiSettings({ connection }) {
  const styles = useStyles(makeStyles);
  const { emoji, users, me } = connection;
  const [name, setName] = useState('');
  const [message, setMessage] = useState(null);
  // The picture in the editor: {picture, name (a new emoji's), replacing (the emoji getting a new picture)}.
  const [editing, setEditing] = useState(null);

  const all = Object.values(emoji);
  const mine = all.filter((item) => item.owner_id === me.id);
  const others = all.filter((item) => item.owner_id !== me.id);
  const amAdmin = users[me.id]?.admin === true;

  async function choose(choice) {
    setMessage(null);
    try {
      const picture = await pickPicture();
      if (picture) setEditing({ picture, ...choice });
    } catch (error) {
      setMessage({ text: error.message, error: true });
    }
  }

  // Check the name first (the server checks again), so nobody crops a picture for nothing.
  function addNew() {
    const wanted = name.trim();
    if (!NAME_PATTERN.test(wanted)) {
      setMessage({ text: 'Names are 2–32 letters, digits or _.', error: true });
      return;
    }
    if (all.some((item) => item.name.toLowerCase() === wanted.toLowerCase())) {
      setMessage({ text: `There's already an emoji called :${wanted}:.`, error: true });
      return;
    }
    choose({ name: wanted, replacing: null });
  }

  async function upload(picture) {
    const { name: newName, replacing } = editing;
    setEditing(null);
    setMessage({ text: 'Uploading…' });
    // A new emoji needs its name; a replaced one keeps its own (its id is in the address instead).
    const problem = replacing
      ? await uploadPicture(`/custom-emoji/${replacing.id}/picture`, picture)
      : await uploadPicture('/custom-emoji', picture, { name: newName });
    if (problem) {
      setMessage({ text: problem, error: true });
    } else if (replacing) {
      setMessage({ text: `New picture for :${replacing.name}:` });
    } else {
      setMessage({ text: `Added :${newName}:` });
      setName('');
    }
  }

  async function remove(item) {
    const result = await deleteJson('/custom-emoji/' + item.id);
    if (!result.ok) setMessage({ text: "Couldn't delete it.", error: true });
  }

  const row = (item, showOwner) => (
    <EmojiRow
      key={item.id} item={item} owner={showOwner ? users[item.owner_id]?.name ?? 'someone' : null}
      onReplace={() => choose({ replacing: item })} onDelete={() => remove(item)}
    />
  );

  return (
    <View>
      <Title>Emoji</Title>
      <Form>
        <Text style={styles.count}>Your emoji: {mine.length}/{MAX_CUSTOM_EMOJI}. Everyone can react with them.</Text>
        <View style={styles.list}>
          {mine.map((item) => row(item, false))}
          {amAdmin && others.length ? (
            <>
              <Help>Everyone else's emoji (as an admin you can replace or delete them):</Help>
              {others.map((item) => row(item, true))}
            </>
          ) : null}
        </View>
        <Field
          label="Name for a new emoji" value={name} onChangeText={setName} maxLength={32} placeholder="e.g. pog"
          autoCapitalize="none" autoCorrect={false}
        />
        <Button label="Choose picture…" onPress={addNew} disabled={mine.length >= MAX_CUSTOM_EMOJI} />
        <Status status={message} />
      </Form>
      {editing ? <PictureEditor picture={editing.picture} kind="emoji" onDone={upload} onCancel={() => setEditing(null)} /> : null}
    </View>
  );
}

// chat.css's .my-emoji-item: the picture 32px, 10px apart, the buttons at the right end.
const makeStyles = (colors, size) => StyleSheet.create({
  count: { fontSize: size(16), color: colors.text },
  list: { gap: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { flex: 1, color: colors.text, fontSize: size(16) },
});
