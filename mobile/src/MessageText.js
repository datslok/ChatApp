// Drawing a message the web page's way: its formatted text (format.js's tree), custom emoji as
// pictures, link preview cards and attachments. The sizes and colours are chat.css's.
import { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import MathView from './MathView';
import { colors } from './colors';
import { SERVER } from './config';
import { isOnlyEmoji, parseMessage, tokensToCodes } from './format';

// A custom emoji's picture. /custom-emoji/files/ only answers logged-in people; React Native's
// <Image> sends the login cookie along like everything else. (Animated ones play: animated WebP is
// switched on by plugins/animated-webp.js, GIF is on by default.)
export function customEmojiUrl(item) {
  return `${SERVER}/custom-emoji/files/${encodeURIComponent(item.file)}`;
}

export function CustomEmoji({ item, size }) {
  if (!item) return <Text>:deleted:</Text>;  // that emoji no longer exists
  return (
    <Image
      source={{ uri: customEmojiUrl(item) }}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel={`:${item.name}:`}
    />
  );
}

function openLink(url) {
  Linking.openURL(url);  // in the phone's browser (the web page opens a new tab)
}

// "1.5 KB", like the web page's formatSize.
export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ----- The text

// A ||spoiler||: a dark bar until tapped. While hidden it shows only blank text the same length
// (so nothing inside it, links or mentions, can be tapped or read); once revealed, the real thing.
function Spoiler({ parts, context }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return <Text style={styles.spoilerHidden} onPress={() => setRevealed(true)}>{plainText(parts, context)}</Text>;
  }
  return <Text style={styles.spoilerRevealed}>{renderInline(parts, context)}</Text>;
}

// The pieces as plain text: what a hidden spoiler is as long as.
function plainText(parts, context) {
  return parts.map((part) => {
    if (part.parts) return plainText(part.parts, context);
    if (part.type === 'link') return part.url;
    if (part.type === 'mention') return '@' + (part.id === 'everyone' ? 'everyone' : context.users[part.id]?.name ?? 'unknown');
    if (part.type === 'emoji') return '  ';
    return part.text ?? part.tex ?? '';
  }).join('');
}

// The inline pieces as React Native elements. A <Text> inside a <Text> carries on the same line
// with its own style added, like a <span> in HTML; pictures and maths can sit in the line too.
function renderInline(parts, context) {
  const { users, emoji, jumbo } = context;
  return parts.map((part, index) => {
    switch (part.type) {
      case 'text':
        return part.text;
      case 'code':
        return <Text key={index} style={styles.code}>{tokensToCodes(part.text, users, emoji)}</Text>;
      case 'math':
        return <MathView key={index} tex={tokensToCodes(part.tex, users, emoji)} display={false} />;
      case 'link':
        return <Text key={index} style={styles.link} onPress={() => openLink(part.url)}>{part.url}</Text>;
      case 'mention': {
        const name = part.id === 'everyone' ? 'everyone' : users[part.id]?.name ?? 'unknown';
        return <Text key={index} style={styles.mention}>@{name}</Text>;
      }
      case 'emoji':
        // In a line: 1.3 times the text's size; in a jumbo message: 48 px.
        return <CustomEmoji key={index} item={emoji[part.id]} size={jumbo ? 48 : 21} />;
      case 'bold':
        return <Text key={index} style={styles.bold}>{renderInline(part.parts, context)}</Text>;
      case 'italic':
        return <Text key={index} style={styles.italic}>{renderInline(part.parts, context)}</Text>;
      case 'strike':
        return <Text key={index} style={styles.strike}>{renderInline(part.parts, context)}</Text>;
      case 'spoiler':
        return <Spoiler key={index} parts={part.parts} context={context} />;
      default:
        return null;
    }
  });
}

// A paragraph with $inline maths$ is laid out differently. Inside one <Text>, Android can only give
// a formula a fixed space, so a formula that turns out bigger spilled over the next line. Instead it
// becomes a row of words that wraps by itself (flexWrap), with each formula one item among the words,
// as big as KaTeX makes it. `atoms` flattens the pieces into those items: words (with the styles of
// what they're inside: bold, a link...), formulas, emoji, and line breaks.
function atoms(parts, context, styles_ = [], onPress = null) {
  const result = [];
  for (const part of parts) {
    if (part.type === 'text') {
      for (const line of part.text.split(/(\n)/)) {
        if (line === '\n') result.push({ type: 'break' });
        // Each word with the spaces after it ("bold ", "and "), so the wrapping happens between words.
        else for (const word of line.match(/\S+\s*|\s+/g) ?? []) result.push({ type: 'word', text: word, styles: styles_, onPress });
      }
    } else if (part.type === 'math') {
      result.push({ type: 'math', tex: part.tex });
    } else if (part.type === 'bold' || part.type === 'italic' || part.type === 'strike') {
      result.push(...atoms(part.parts, context, [...styles_, styles[part.type]], onPress));
    } else if (part.type === 'link') {
      result.push({ type: 'word', text: part.url, styles: [...styles_, styles.link], onPress: () => openLink(part.url) });
    } else {
      result.push({ type: 'inline', part, styles: styles_ });  // code, a mention, an emoji, a spoiler: as they are
    }
  }
  return result;
}

function WrappedParagraph({ parts, context, textStyle, tail }) {
  const items = atoms(parts, context);
  return (
    <View style={styles.wrapped}>
      {items.map((item, index) => {
        if (item.type === 'break') return <View key={index} style={styles.lineBreak} />;
        if (item.type === 'math') {
          return <MathView key={index} tex={tokensToCodes(item.tex, context.users, context.emoji)} display={false} />;
        }
        if (item.type === 'word') {
          return <Text key={index} style={[textStyle, ...item.styles]} onPress={item.onPress ?? undefined}>{item.text}</Text>;
        }
        return <Text key={index} style={[textStyle, ...item.styles]}>{renderInline([item.part], context)}</Text>;
      })}
      {tail ? <Text style={textStyle}>{tail}</Text> : null}
    </View>
  );
}

// A paragraph's pieces. $$maths$$ sits on a line of its own, so the text is cut there: text, the
// formula, more text. `tail`: what goes at the very end (the "(edited)" label).
function renderParagraph(parts, context, textStyle, tail, keyPrefix) {
  const runs = [[]];
  for (const part of parts) {
    if (part.type === 'math' && part.display) runs.push(part, []);
    else runs[runs.length - 1].push(part);
  }
  return runs.map((run, index) => {
    const last = index === runs.length - 1;
    if (!Array.isArray(run)) {
      return <MathView key={keyPrefix + index} tex={tokensToCodes(run.tex, context.users, context.emoji)} display />;
    }
    if (run.length === 0 && !(last && tail)) return null;
    if (hasInlineMath(run)) {
      return <WrappedParagraph key={keyPrefix + index} parts={run} context={context} textStyle={textStyle} tail={last ? tail : null} />;
    }
    return (
      <Text key={keyPrefix + index} style={textStyle}>
        {renderInline(run, context)}
        {last ? tail : null}
      </Text>
    );
  });
}

// Is there an inline formula in these pieces (or inside bold, italic... ones)?
function hasInlineMath(parts) {
  return parts.some((part) => (part.type === 'math' && !part.display) || (part.parts && hasInlineMath(part.parts)));
}

// A message's whole text: code blocks, quotes and paragraphs, with " (edited)" after the last
// line. A message of only emoji (1 to 27) is drawn big, like the web page's .jumbo.
// One emoji as people see it, though it may be several characters: a flag (two letters), a keycap
// (1️⃣), or a picture with its marks (FE0F, skin tones), joined to more by "glue" (200D) like 👩‍💻.
const ONE_EMOJI = /\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]*(?:‍\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]*)*/gu;

// A message of only emoji, drawn big: a row of pieces centred on each other, the custom ones as 48 px
// pictures and the rest as text without a fixed line height. (In one line of text, Android sat the
// emoji lower than the pictures and cut off their bottoms.) split() keeps the <:17> tokens' ids.
function JumboEmoji({ text, emoji, editedLabel }) {
  return (
    <View style={styles.jumboRow}>
      {text.split(/<:(\d+)>/).map((part, index) => {
        if (index % 2 === 1) return <CustomEmoji key={index} item={emoji[part]} size={48} />;
        // Each emoji a piece of its own: Android measured a run of big emoji too narrow, and cut the
        // last one off. (The spaces between them: the row's gap does that.)
        return (part.match(ONE_EMOJI) ?? []).map((one, n) => <Text key={`${index}-${n}`} style={styles.jumboText}>{one}</Text>);
      })}
      {editedLabel}
    </View>
  );
}

export default function MessageText({ text, users, emoji, edited, note }) {
  const jumbo = isOnlyEmoji(text);
  if (jumbo) {
    return <JumboEmoji text={text} emoji={emoji} editedLabel={edited ? <Text style={styles.edited}>(edited)</Text> : null} />;
  }
  const context = { users, emoji, jumbo };
  const textStyle = [styles.text, jumbo && styles.jumbo, note && styles.note];
  const blocks = parseMessage(text);
  const editedLabel = edited ? <Text style={styles.edited}> (edited)</Text> : null;
  const lastBlock = blocks[blocks.length - 1];
  const tailInside = editedLabel && lastBlock && lastBlock.type !== 'code';

  return (
    <View>
      {blocks.map((block, index) => {
        const tail = tailInside && index === blocks.length - 1 ? editedLabel : null;
        if (block.type === 'code') {
          return (
            <View key={index} style={styles.codeBlock}>
              <Text style={styles.codeBlockText}>{tokensToCodes(block.text, users, emoji)}</Text>
            </View>
          );
        }
        if (block.type === 'quote') {
          return (
            <View key={index} style={styles.quote}>
              {renderParagraph(block.parts, context, textStyle, tail, `${index}-`)}
            </View>
          );
        }
        return renderParagraph(block.parts, context, textStyle, tail, `${index}-`);
      })}
      {editedLabel && !tailInside ? <Text>{editedLabel}</Text> : null}
    </View>
  );
}

// ----- Pictures that keep their shape

// A picture as big as fits in maxWidth x maxHeight without changing its shape (CSS max-width +
// max-height). Its size is only known once loaded (onLoad), so until then it takes a small space.
export function FittedImage({ uri, maxWidth, maxHeight, style, onPress }) {
  const [natural, setNatural] = useState(null);   // the picture's own {width, height}
  const [room, setRoom] = useState(maxWidth);      // how wide it may be here (the column may be narrower)
  let size = { width: Math.min(room, maxWidth), height: 120 };
  if (natural) {
    const scale = Math.min(1, Math.min(room, maxWidth) / natural.width, maxHeight / natural.height);
    size = { width: natural.width * scale, height: natural.height * scale };
  }
  const picture = (
    <Image
      source={{ uri }}
      style={[size, style]}
      resizeMode="contain"
      onLoad={(event) => setNatural({ width: event.nativeEvent.source.width, height: event.nativeEvent.source.height })}
    />
  );
  return (
    <View style={styles.fitted} onLayout={(event) => setRoom(event.nativeEvent.layout.width)}>
      {onPress ? <Pressable onPress={onPress}>{picture}</Pressable> : picture}
    </View>
  );
}

// ----- What comes after the text

// An attached file: a picture is shown (at most 400 x 300); any other file shows its name and size.
// (Opening pictures full size and downloading files come with the "Pictures and files" step.)
export function Attachment({ file }) {
  if (file.image) {
    return <FittedImage uri={`${SERVER}/uploads/${encodeURIComponent(file.id)}`} maxWidth={400} maxHeight={300} style={styles.attachmentImage} />;
  }
  return (
    <View style={styles.attachmentFile}>
      <Icon name="file" size={16} color={colors.textSoft} />
      <Text style={styles.attachmentName}>{file.filename} ({formatSize(file.size)})</Text>
    </View>
  );
}

// A link's preview card (the web page's makePreviewCard): the site, the title (a link), a
// description and a picture, all fetched by our server; the picture comes from our server too.
export function LinkPreview({ preview }) {
  return (
    <View style={styles.preview}>
      {preview.site ? <Text style={styles.previewSite}>{preview.site}</Text> : null}
      {preview.title ? (
        <Text style={styles.previewTitle} onPress={() => openLink(preview.url)}>{preview.title}</Text>
      ) : null}
      {preview.description ? <Text style={styles.previewDescription}>{preview.description}</Text> : null}
      {preview.image ? (
        <FittedImage
          uri={SERVER + preview.image} maxWidth={404} maxHeight={300} style={styles.previewImage}
          onPress={() => openLink(preview.url)}
        />
      ) : null}
    </View>
  );
}

// chat.css's sizes (rem as 16 px).
const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 22, color: colors.text },
  note: { color: colors.textMuted, fontStyle: 'italic' },
  jumbo: { fontSize: 41.6, lineHeight: 50 },
  // .jumbo: emoji at 2.6rem; pictures 48 px; all centred on one line, wrapping when there are many.
  jumboRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  jumboText: { fontSize: 41.6, color: colors.text },
  edited: { fontSize: 11.2, color: colors.textMuted, fontStyle: 'normal' },
  bold: { fontWeight: 'bold' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { color: colors.link },
  mention: { backgroundColor: colors.accent30, color: colors.mentionText, fontWeight: '500' },
  // `code` and code blocks: monospace at 0.875em, on the panel colour.
  code: { fontFamily: 'monospace', fontSize: 14, backgroundColor: colors.bgPanel },
  codeBlock: {
    marginVertical: 4, padding: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bgPanel,
  },
  codeBlockText: { fontFamily: 'monospace', fontSize: 14, lineHeight: 20, color: colors.text },
  // > quotes: a 4px bar on the left.
  quote: { marginVertical: 2, paddingLeft: 12, borderLeftWidth: 4, borderLeftColor: colors.bgNeutral },
  // (The text in the bar's own colour: Android ignores "transparent" text inside a line.)
  spoilerHidden: { backgroundColor: colors.bgDarkest, color: colors.bgDarkest },
  spoilerRevealed: { backgroundColor: 'rgba(255, 255, 255, 0.1)' },
  fitted: { alignSelf: 'stretch', alignItems: 'flex-start' },
  // A paragraph with inline maths: a row of words that wraps; a line break is a full-width nothing.
  wrapped: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  lineBreak: { width: '100%', height: 0 },
  attachmentImage: { marginTop: 4, borderRadius: 8 },
  attachmentFile: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  attachmentName: { color: colors.textSoft, fontSize: 14 },
  // .link-preview: a card with a 4px line on its left.
  preview: {
    maxWidth: 432, marginTop: 6, paddingTop: 10, paddingHorizontal: 14, paddingBottom: 12, gap: 4,
    borderLeftWidth: 4, borderLeftColor: colors.border, borderRadius: 4, backgroundColor: colors.bgPanel,
  },
  previewSite: { fontSize: 12, color: colors.textSoft },
  previewTitle: { fontWeight: '600', color: colors.link, fontSize: 16 },
  previewDescription: { fontSize: 13.6, color: colors.text },
  previewImage: { marginTop: 6, borderRadius: 4 },
});
