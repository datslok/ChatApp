// Settings → Profile (the web page's settings.js): your picture, banner, status line and bio.
//
// A new picture or banner: chosen with Android's photo picker, then moved and zoomed in the picture
// editor (PictureEditor.js, the web page's), which also keeps animated GIFs animated. Nothing is
// uploaded until Save there. The server then sends everyone a fresh "users", which shows it here too.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { deleteJson, postJson } from './api';
import { uploadPicture } from './files';
import { Avatar } from './people';
import PictureEditor, { pickPicture } from './PictureEditor';
import { Banner } from './ProfileScreen';
import { Button, Field, Form, Status, Title } from './SettingsParts';
import { useStyles } from './theme';
import { limits } from './limits';

const DONE = { avatar: 'Picture changed.', banner: 'Banner changed.' };


export default function ProfileSettings({ connection }) {
  const styles = useStyles(makeStyles);
  const { users, me } = connection;
  const mine = users[me.id];
  // The boxes start with what's saved now.
  const [status, setStatus] = useState(mine?.status ?? '');
  const [bio, setBio] = useState(mine?.bio ?? '');
  const [message, setMessage] = useState(null);  // the status line: {text, error}
  const [busy, setBusy] = useState(false);       // a picture is on its way

  const [editing, setEditing] = useState(null);  // the picture in the editor: {picture, kind}

  async function changePicture(kind) {
    setMessage(null);
    try {
      const picture = await pickPicture();
      if (picture) setEditing({ picture, kind });
    } catch (error) {
      setMessage({ text: error.message, error: true });
    }
  }

  // Save in the editor: upload what it made.
  async function upload(picture) {
    const { kind } = editing;
    setEditing(null);
    setBusy(true);
    setMessage({ text: 'Uploading…' });
    const problem = await uploadPicture('/settings/' + kind, picture);
    setMessage(problem ? { text: problem, error: true } : { text: DONE[kind] });
    setBusy(false);
  }

  async function removePicture(kind) {
    const result = await deleteJson('/settings/' + kind);
    setMessage(result.ok ? { text: 'Removed.' } : { text: result.error, error: true });
  }

  async function save() {
    const result = await postJson('/settings/profile', { status, bio });
    setMessage(result.ok ? { text: 'Profile saved.' } : { text: result.error, error: true });
  }

  if (!mine) return null;
  return (
    <View>
      <Title>Profile</Title>
      <Form>
        {/* #avatar-row: the picture, Change picture, Remove. */}
        <View style={styles.row}>
          <Avatar user={mine} size={96} />
          <Button label="Change picture" small onPress={() => changePicture('avatar')} disabled={busy} style={styles.inRow} />
          <Button label="Remove" small secondary onPress={() => removePicture('avatar')} style={styles.inRow} />
        </View>
        <View style={styles.banner}>
          <Banner user={mine} />
        </View>
        <View style={styles.row}>
          <Button label="Change banner" small onPress={() => changePicture('banner')} disabled={busy} />
          <Button label="Remove" small secondary onPress={() => removePicture('banner')} />
        </View>
        <Field label="Status" value={status} onChangeText={setStatus} maxLength={limits.status} placeholder="e.g. 🎮 playing Minecraft" />
        <Field
          label="Bio" value={bio} onChangeText={setBio} maxLength={limits.bio} placeholder="A few words about yourself"
          multiline style={styles.bio}
        />
        <Status status={message} />
        <Button label="Save profile" onPress={save} />
      </Form>
      {editing ? (
        <PictureEditor picture={editing.picture} kind={editing.kind} onDone={upload} onCancel={() => setEditing(null)} />
      ) : null}
    </View>
  );
}

const makeStyles = () => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  banner: { borderRadius: 6, overflow: 'hidden' },  // #settings-banner .banner: rounded corners
  inRow: { alignSelf: 'center' },  // beside the picture's middle (a form's buttons start at its top left)
  bio: { minHeight: 80, textAlignVertical: 'top' },  // three lines' room (the web page's rows="3")
});
