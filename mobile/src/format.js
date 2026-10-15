// Message text formatting: the web page's (messages.js, "Text formatting"), rule for rule, but
// building a little tree of plain objects instead of page elements. MessageText.js draws the tree.
//
// Two levels, like the web page. Blocks first: ```code blocks``` (shown exactly as typed) and lines
// starting with "> " (quotes). Then, inside the rest, the inline markers: `code`, $maths$, links,
// **bold**, *italic*, ~~strikethrough~~ and ||spoilers||, and the server's tokens for mentions
// (<@2>, <@everyone>) and custom emoji (<:17>).
//
// The tree: a list of blocks, {type: 'text' | 'quote', parts} or {type: 'code', text}. `parts` is a
// list of inline pieces: {type: 'text', text}, {type: 'code', text}, {type: 'math', tex, display},
// {type: 'link', url}, {type: 'mention', id} (a number, or 'everyone'), {type: 'emoji', id},
// and {type: 'bold' | 'italic' | 'strike' | 'spoiler', parts}.

// ----- Blocks

export function parseMessage(text) {
  const blocks = [];
  // With the (group), the code blocks' insides end up at the odd positions. An optional language
  // name on the opening line ("```py") is left out, like Discord does.
  const parts = text.split(/```(?:[\w+#-]*\n)?([\s\S]*?)```/);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({ type: 'code', text: part.replace(/\n$/, '') });
      return;
    }
    // A block is on lines of its own anyway, so the line break next to it would be one too many.
    if (index > 0) part = part.replace(/^\n/, '');
    if (index < parts.length - 1) part = part.replace(/\n$/, '');
    if (part) blocks.push(...parseLines(part));
  });
  return blocks;
}

// Lines starting with "> " (or a lone ">") become quotes; neighbouring lines of the same kind go
// together, so a three-line quote is one quote.
function parseLines(text) {
  const isQuote = (line) => line.startsWith('> ') || line === '>';
  const lines = text.split('\n');
  const blocks = [];
  let start = 0;
  while (start < lines.length) {
    const quote = isQuote(lines[start]);
    let end = start;
    while (end < lines.length && isQuote(lines[end]) === quote) end++;  // the group: start..end-1
    const group = lines.slice(start, end);
    if (quote) {
      blocks.push({ type: 'quote', parts: parseInline(group.map((line) => line.slice(2)).join('\n')) });
    } else {
      blocks.push({ type: 'text', parts: parseInline(group.join('\n')) });
    }
    start = end;
  }
  return blocks;
}

// ----- Inline markers

// One pattern with a (group) for each kind. exec() finds the earliest place where any of them
// matches; where two could start at the same place, the first one listed wins (so "**" is bold
// before it's two italic stars). $maths$ follows Pandoc's rule, so money stays text.
const INLINE_PATTERN = [
  /\\([\\*~|`>$])/.source,               // 1: \* is a real star (an "escaped" marker)
  /(`+)([^`][\s\S]*?)\2(?!`)/.source,    // 2, 3: `code` (``code with a ` in it`` too)
  /\$\$([\s\S]+?)\$\$/.source,           // 4: $$maths$$ on a line of its own, centred
  /\$(?![\s$])([^$\n]*?[^\s\\])\$(?!\d)/.source,  // 5: $maths$ inside the sentence
  /(https?:\/\/[^\s<]+)/.source,         // 6: a web address, so formatting can't cut through one
  /\*\*([\s\S]+?)\*\*(?!\*)/.source,     // 7: **bold** (the (?!\*) makes ***this*** bold italic)
  /\*(?![\s*])([\s\S]*?\S)\*/.source,    // 8: *italic* (not "5 * 3 * 2": no space inside the stars)
  /~~([\s\S]+?)~~/.source,               // 9: ~~strikethrough~~
  /\|\|([\s\S]+?)\|\|/.source,           // 10: ||spoiler||
].join('|');

// A web address: http:// or https://, then everything up to a space or a "<".
const URL_PATTERN = /https?:\/\/[^\s<]+/g;

export function parseInline(text) {
  // A new pattern each call: a "g" pattern remembers where it got to (lastIndex), and the calls
  // inside this one (for what's between the markers) would otherwise move it.
  const pattern = new RegExp(INLINE_PATTERN, 'g');
  const parts = [];
  let position = 0;  // how far into the text we've got
  while (true) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (match === null) break;
    let before = text.slice(position, match.index);  // the plain text before it
    // $$maths$$ is on a line of its own anyway, so the line breaks next to it would be one too many.
    if (match[4] !== undefined) before = before.replace(/\n$/, '');
    parts.push(...parsePlain(before));
    position = match.index + match[0].length;

    // A group that took no part in the match is undefined; the one that did says which kind.
    if (match[1] !== undefined) {
      parts.push({ type: 'text', text: match[1] });
    } else if (match[3] !== undefined) {
      parts.push({ type: 'code', text: match[3] });  // (shown as typed: no emoji, links or formatting)
    } else if (match[4] !== undefined) {
      parts.push({ type: 'math', tex: match[4], display: true });
      if (text[position] === '\n') position++;
    } else if (match[5] !== undefined) {
      parts.push({ type: 'math', tex: match[5], display: false });
    } else if (match[6] !== undefined) {
      const url = trimUrl(match[6]);
      parts.push({ type: 'link', url });
      position = match.index + url.length;  // what trimUrl cut off is looked at again
    } else if (match[7] !== undefined) {
      parts.push({ type: 'bold', parts: parseInline(match[7]) });  // (the inside is formatted too)
    } else if (match[8] !== undefined) {
      parts.push({ type: 'italic', parts: parseInline(match[8]) });
    } else if (match[9] !== undefined) {
      parts.push({ type: 'strike', parts: parseInline(match[9]) });
    } else {
      parts.push({ type: 'spoiler', parts: parseInline(match[10]) });
    }
  }
  parts.push(...parsePlain(text.slice(position)));  // the plain text after the last one
  return parts;
}

// Plain text: the server's tokens (<:17>, <@2>, <@everyone>) as emoji and mentions, and web
// addresses as links. split() with a (group) keeps the tokens' insides at the odd positions:
// "hi <:17> and <@2>!" -> ["hi ", ":17", " and ", "@2", "!"].
function parsePlain(text) {
  const parts = [];
  text.split(/<(:\d+|@\d+|@everyone)>/).forEach((part, index) => {
    if (index % 2 === 0) {
      parts.push(...parseLinks(part));
    } else if (part.startsWith(':')) {
      parts.push({ type: 'emoji', id: Number(part.slice(1)) });
    } else {
      const who = part.slice(1);
      parts.push({ type: 'mention', id: who === 'everyone' ? 'everyone' : Number(who) });
    }
  });
  return parts;
}

function parseLinks(text) {
  const parts = [];
  let position = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (match.index > position) parts.push({ type: 'text', text: text.slice(position, match.index) });
    parts.push({ type: 'link', url });
    position = match.index + url.length;  // what trimUrl cut off is added as text next time
  }
  if (position < text.length) parts.push({ type: 'text', text: text.slice(position) });
  return parts;
}

// Punctuation at the end of an address usually belongs to the sentence: "see https://x.com."
// A ")" stays if the address has a "(" of its own, like Wikipedia's ".../Python_(language)".
function trimUrl(url) {
  while (true) {
    const last = url.slice(-1);
    const opens = url.split('(').length - 1;
    const closes = url.split(')').length - 1;
    // (Also formatting markers: in "**https://x.com**" the stars are bold's, not the address's.)
    if ('.,!?:;\'"*~|'.includes(last) || (last === ')' && closes > opens)) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

// ----- Tokens as typed, for code and maths (nothing inside those is formatted)

export function tokensToCodes(text, users, emoji) {
  return text
    .replace(/<:(\d+)>/g, (whole, id) => (emoji[id] ? `:${emoji[id].name}:` : ':deleted:'))
    .replace(/<@everyone>/g, '@everyone')
    .replace(/<@(\d+)>/g, (whole, id) => '@' + (users[id]?.name ?? 'unknown'));
}

// ----- Jumbo emoji: a message of only emoji (1 to 27) is drawn big.
//
// \p{...} (with the u flag) matches a whole Unicode category: Extended_Pictographic = emoji
// pictures, Regional_Indicator = the letters flags are made of. Also removed: skin tones, the "glue"
// between combined emoji (200D), the "show as emoji" mark (FE0F) and the keycap mark (20E3).
const EMOJI_PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu;
const EMOJI_PARTS = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|‍|️|⃣|\s/gu;
const MAX_JUMBO_EMOJI = 27;
const CUSTOM_EMOJI_TOKEN = /<:\d+>/g;

export function isOnlyEmoji(text) {
  const count = (text.match(EMOJI_PICTURE) || []).length + (text.match(CUSTOM_EMOJI_TOKEN) || []).length;
  const leftover = text.replace(CUSTOM_EMOJI_TOKEN, '').replace(EMOJI_PARTS, '');
  return count > 0 && count <= MAX_JUMBO_EMOJI && leftover === '';
}
