// Files going up and coming down: uploading what we picked, downloading an attachment into the
// app's own storage, then opening it in another app or sharing it (the web page's messages.js,
// "Uploads", and the desktop app's downloads).
//
// Both go through Expo's fetch (expo/fetch), not expo-file-system's own upload and download: those
// use an HTTP client without React Native's cookies, so the server would answer "not logged in".
// Expo's fetch shares the cookie jar that /login filled.
import { fetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { saveToDownloads } from '../modules/downloads';
import { SERVER } from './config';

export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;  // 50 MB, same as the server
export const MAX_TRAY_FILES = 10;                   // the web page's limit too

// The types the server shows as pictures (server.py's IMAGE_TYPES); anything else is a download.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Upload one file (a tray item: {uri, name, type}). Returns its id from the server; throws an
// Error with something to show if it failed.
export async function uploadFile(item) {
  let response;
  try {
    // The body is the file itself (an expo-file-system File, read from wherever Android keeps it);
    // its name goes in the URL, as on the web page.
    response = await fetch(`${SERVER}/upload?filename=${encodeURIComponent(item.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': item.type || 'application/octet-stream' },
      body: new File(item.uri),
    });
  } catch {
    throw new Error(`Couldn't upload ${item.name}`);  // no network, or the file couldn't be read
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The server's reason if it gave one, like "Files can be at most 50 MB."
    throw new Error(typeof answer.detail === 'string' ? answer.detail : `Couldn't upload ${item.name}`);
  }
  return answer.id;
}

// A picture from the picture editor (PictureEditor.js): a profile picture or banner ("/settings/avatar"),
// a new custom emoji ("/custom-emoji", its name in params) or a new picture for one. `picture` is the
// editor's {uri, type, params}: a WebP it cut out, or a whole GIF with its rectangle in params. The
// server answers everyone with a fresh "users" or "custom_emoji", which shows it. Returns null, or
// what went wrong.
export async function uploadPicture(path, picture, extra = {}) {
  // {name: "pog", left: 0, ...} -> "name=pog&left=0&..." (each part made safe for an address).
  const query = Object.entries({ ...extra, ...picture.params })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  try {
    const response = await fetch(`${SERVER}${path}${query ? '?' + query : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': picture.type },
      body: new File(picture.uri),
    });
    if (response.ok) return null;
    const answer = await response.json().catch(() => ({}));
    return typeof answer.detail === 'string' ? answer.detail : 'Upload failed.';
  } catch {
    return "Couldn't reach the server. Try again in a moment.";
  }
}

// Where an attachment is kept once downloaded: the app's cache (Android may clear it when space
// runs low), in a folder per file id so two files called "notes.pdf" don't overwrite each other.
// It keeps its own name, so the app that opens it shows the right one.
function localCopy(file) {
  const folder = new Directory(Paths.cache, 'downloads', file.id);
  return { folder, copy: new File(folder, file.filename.replace(/[\\/:*?"<>|]/g, '_')) };
}

// The downloaded copy of an attachment ({id, filename, size} from a message), if we have one.
export function downloaded(file) {
  const { copy } = localCopy(file);
  return copy.exists && copy.size === file.size ? copy : null;
}

// Download an attachment, calling onProgress(0..1) as it comes. Returns the local File.
// The answer is read piece by piece (a stream) and each piece is written straight to the file,
// so we know how far along it is and a big file never sits in memory all at once.
export async function downloadFile(file, onProgress) {
  const already = downloaded(file);
  if (already) return already;

  const response = await fetch(`${SERVER}/uploads/${encodeURIComponent(file.id)}`);
  if (!response.ok) throw new Error("Couldn't download the file");

  const { folder, copy } = localCopy(file);
  folder.create({ intermediates: true, idempotent: true });  // (idempotent: no error if it's there)
  copy.create({ overwrite: true });
  const handle = copy.open();
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();  // the next piece, as bytes (a Uint8Array)
      if (done) break;
      handle.writeBytes(value);
      received += value.length;
      onProgress?.(Math.min(1, received / file.size));
    }
  } catch (error) {
    handle.close();
    copy.delete();  // half a file is no use
    throw new Error("Couldn't download the file");
  }
  handle.close();
  return copy;
}

// Open a saved file in another app: Android's "open with" (an intent, ACTION_VIEW). uri: its content://
// address in Download (from saveFile); flag 1 (FLAG_GRANT_READ_URI_PERMISSION) lets the chosen app read
// that one file, which Android allows the app that made it. False if no app can open it.
export async function openFile(uri, type) {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: uri,
      flags: 1,
      type: type || '*/*',
    });
    return true;
  } catch {
    return false;
  }
}

// Android's share sheet for a downloaded file: send it somewhere, or save it (Drive, Files, …).
export async function shareFile(copy) {
  await Sharing.shareAsync(copy.uri, { mimeType: copy.type || undefined, dialogTitle: copy.name });
}

// Save a downloaded attachment in the phone's Download folder (our own module, modules/downloads),
// under its name in the chat, then delete the app's own copy: the one in Download is the one to keep.
// Returns {name, uri, type}: the name it got there ("cat (2).jpg" when "cat.jpg" was already in
// Download), its content:// address, and its type (both for openFile).
export async function saveFile(file, copy) {
  const type = copy.type || 'application/octet-stream';
  const saved = await saveToDownloads(copy.uri, file.filename, type);
  localCopy(file).folder.delete();
  return { ...saved, type };
}

// Empty the app's folders of copies (at every start): downloads/ was only needed for Open and Share,
// and the other app has long since read it; shared/ holds files shared to the app (modules/shared-files)
// for the tray, which doesn't outlive the app.
export function clearOldCopies() {
  for (const name of ['downloads', 'shared']) {
    try {
      const folder = new Directory(Paths.cache, name);
      if (folder.exists) folder.delete();
    } catch {
      // Not worth bothering anyone about: Android empties the cache by itself when space runs low.
    }
  }
}
