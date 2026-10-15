// "What's new" (the web page's settings.js): the server's /changelog.json, written by hand, with
//   "changes":  what changed when, newest day first: [{date: "2026-10-12", items: [...]}]
//   "features": everything the chat can do, by topic: [{topic: "💬 Messages", items: [...]}]
// The phone remembers how many lines of "changes" it has shown (the web page keeps that number in
// localStorage; here it's a small file, like appearance.json). More lines than that puts a red dot on
// ⚙️ and on the What's new tab, until it's opened.
import { File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { SERVER } from './config';

const seenFile = new File(Paths.document, 'changelog-seen.txt');

function loadSeen() {
  try {
    if (seenFile.exists) return Number(seenFile.textSync()) || 0;
  } catch {}
  return 0;
}

// How many lines "changes" has, over all its days.
function countLines(changelog) {
  return changelog.changes.reduce((count, entry) => count + entry.items.length, 0);
}

// `reload`: a value that changes at every connect ("welcome": a new `me`). The server restarts with
// every deploy, so a fresh connection is when the changelog may have new lines.
export function useChangelog(reload) {
  const [changelog, setChangelog] = useState(null);  // the file's contents, once fetched
  const [seen, setSeen] = useState(loadSeen);

  useEffect(() => {
    fetch(SERVER + '/changelog.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setChangelog(data))
      .catch(() => {});  // offline or a broken file: no dot, and the page stays empty
  }, [reload]);

  // What's new was opened: everything in it now counts as seen.
  function markSeen() {
    if (!changelog) return;
    const count = countLines(changelog);
    setSeen(count);
    try {
      if (!seenFile.exists) seenFile.create();
      seenFile.write(String(count));
    } catch {}
  }

  return { changelog, unseen: !!changelog && countLines(changelog) > seen, markSeen };
}
