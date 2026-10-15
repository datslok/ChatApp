// Our own native module (android/.../SharedFilesModule.kt): files and text shared to the app from
// Android's share sheet. A share is {files: [{uri, name, size, type}], text}: content:// addresses with
// the files' real names (size -1 if unknown), and any text that came along (a link), or null.
import { requireNativeModule } from 'expo';

const SharedFiles = requireNativeModule('SharedFiles');

// The share the app was started with, or null.
export function getInitialShare() {
  return SharedFiles.getInitialShareAsync();
}

// Calls listener(share) for each share while the app is open. Returns a subscription (.remove()).
// (A native module can send events: this is like addEventListener on the web.)
export function addShareListener(listener) {
  return SharedFiles.addListener('onShare', listener);
}

// Copies a shared file into the app's own storage, so it can still be read when it's sent.
// Resolves with {uri, size}: a file:// address and the size of the copy.
export function copySharedFile(uri, name) {
  return SharedFiles.copyAsync(uri, name);
}
