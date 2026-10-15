// Settings → Profile (the web page's settings.js): your picture, banner, status line and bio.
//
// A new picture or banner: the web page has its own editor to move and zoom it. On a phone, Android's
// photo picker can crop by itself (allowsEditing: square for a picture, 3 : 1 for a banner), so the
// app uses that, then shrinks it to the web editor's sizes as WebP (expo-image-manipulator: the server
// takes at most 1 MB for a picture, 2 MB for a banner, and a phone's photos are far bigger). (Animated
// GIFs can't be picked here: the crop would stop them moving. The web page keeps them animated.)
// The server then sends everyone a fresh "users", which shows it here too.
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { deleteJson, postJson } from './api';
import { uploadPicture } from './files';
import { Avatar } from './people';
import { Banner } from './ProfileScreen';
import { Button, Field, Form, Status, Title } from './SettingsParts';
import { useStyles } from './theme';

// The crop's shape and the size it's saved at (the web page's CROP_SHAPES).
const PICTURES = {
  avatar: { aspect: [1, 1], width: 256, height: 256, done: 'Picture changed.' },
  banner: { aspect: [3, 1], width: 960, height: 320, done: 'Banner changed.' },
};

const MAX_STATUS = 60;  // as the server's
const MAX_BIO = 300;

export default function ProfileSettings({ connection }) {
  const styles = useStyles(makeStyles);
  const { users, me } = connection;
  const mine = users[me.id];
  // The boxes start with what's saved now.
  const [status, setStatus] = useState(mine?.status ?? '');
  const [bio, setBio] = useState(mine?.bio ?? '');
  const [message, setMessage] = useState(null);  // the status line: {text, error}
  const [busy, setBusy] = useState(false);       // a picture is on its way

  async function changePicture(kind) {
    const shape = PICTURES[kind];
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsEditing: true, aspect: shape.aspect, quality: 1,
    });
    if (result.canceled) return;
    setBusy(true);
    setMessage({ text: 'Uploading…' });
    try {
      // Shrink the cropped picture to the size it's shown at (a little bigger, to stay sharp).
      const image = await ImageManipulator.manipulate(result.assets[0].uri)
        .resize({ width: shape.width, height: shape.height })
        .renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.WEBP, compress: 0.85 });
      const problem = await uploadPicture(kind, saved.uri);
      setMessage(problem ? { text: problem, error: true } : { text: shape.done });
    } catch {
      setMessage({ text: "Couldn't read that picture.", error: true });
    }
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
        <Field label="Status" value={status} onChangeText={setStatus} maxLength={MAX_STATUS} placeholder="e.g. 🎮 playing Minecraft" />
        <Field
          label="Bio" value={bio} onChangeText={setBio} maxLength={MAX_BIO} placeholder="A few words about yourself"
          multiline style={styles.bio}
        />
        <Status status={message} />
        <Button label="Save profile" onPress={save} />
      </Form>
    </View>
  );
}

const makeStyles = () => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  banner: { borderRadius: 6, overflow: 'hidden' },  // #settings-banner .banner: rounded corners
  inRow: { alignSelf: 'center' },  // beside the picture's middle (a form's buttons start at its top left)
  bio: { minHeight: 80, textAlignVertical: 'top' },  // three lines' room (the web page's rows="3")
});
