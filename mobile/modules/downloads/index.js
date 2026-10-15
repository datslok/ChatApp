// Our own native module (android/.../DownloadsModule.kt): saving a file in the phone's Download folder.
// Expo builds every module in mobile/modules/ into the app by itself (autolinking).
import { requireNativeModule } from 'expo';

const Downloads = requireNativeModule('Downloads');

// uri: a file:// address of our own copy; name: what to call it; type: like "image/jpeg".
// Resolves with {name, uri}: the name it got in Download ("cat (2).jpg" if "cat.jpg" was taken) and
// its content:// address there (for opening it).
export function saveToDownloads(uri, name, type) {
  return Downloads.saveAsync(uri, name, type || 'application/octet-stream');
}
