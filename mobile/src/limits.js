// The server's limits (server.py, LIMITS): limits.custom_emoji, limits.upload_size, ... connection.js
// fills this in from "welcome", the same object every file imports, so server.py is the only place
// they're written. Empty until then, which is fine: nothing that reads them is on screen before we're
// connected. (The server checks every one again: these are only for saying so before trying.)
export const limits = {};

// A size limit in words: 52428800 -> "50 MB".
export function megabytes(bytes) {
  return Math.round(bytes / (1024 * 1024)) + ' MB';
}
