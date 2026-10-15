// Drawing a message the web page's way: its formatted text (format.js's tree), custom emoji as
// pictures, link preview cards and attachments. The sizes and colours are chat.css's.
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useMemo, useState } from 'react';
import { Alert, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { getCookie } from '../modules/cookies';
import ImageViewer from './ImageViewer';
import Icon from './Icon';
import MathView from './MathView';
import { useStyles, useTheme } from './theme';
import { SERVER } from './config';
import { downloadFile, openFile, saveFile } from './files';
import { isOnlyEmoji, parseMessage, tokensToCodes } from './format';
import VideoScreen from './VideoScreen';

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
  const styles = useStyles(makeStyles);
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
  const { users, emoji, jumbo, styles } = context;
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
  const { styles } = context;
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
  const styles = useStyles(makeStyles);
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
  const styles = useStyles(makeStyles);
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
  const styles = useStyles(makeStyles);
  const jumbo = isOnlyEmoji(text);
  if (jumbo) {
    return <JumboEmoji text={text} emoji={emoji} editedLabel={edited ? <Text style={styles.edited}>(edited)</Text> : null} />;
  }
  const context = { users, emoji, jumbo, styles };  // (styles: for the helpers above, which aren't components)
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
export function FittedImage({ uri, maxWidth, maxHeight, style, onPress, onLongPress }) {
  const styles = useStyles(makeStyles);
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
      {onPress ? <Pressable onPress={onPress} onLongPress={onLongPress}>{picture}</Pressable> : picture}
    </View>
  );
}

// ----- What comes after the text

// An attached file: a picture is shown (at most 400 x 300) and a tap opens it full screen; a video gets
// a player; any other file shows its name and size, and a tap downloads it. sender: who sent it (their
// name), or null for us. onLongPress: the message's menu (a tap target inside the message would
// otherwise take the touch).
export function Attachment({ file, sender, onLongPress }) {
  const styles = useStyles(makeStyles);
  const [viewing, setViewing] = useState(false);
  if (file.video) return <VideoAttachment file={file} sender={sender} onLongPress={onLongPress} />;
  if (file.image) {
    return (
      <>
        <FittedImage
          uri={`${SERVER}/uploads/${encodeURIComponent(file.id)}`} maxWidth={400} maxHeight={300}
          style={styles.attachmentImage} onPress={() => setViewing(true)} onLongPress={onLongPress}
        />
        {viewing ? <ImageViewer file={file} onClose={() => setViewing(false)} /> : null}
      </>
    );
  }
  return <FileAttachment file={file} sender={sender} onLongPress={onLongPress} />;
}

// A video: its first picture as big as a picture may be (at most 400 x 300) with a play button on it,
// and the download link under it. A tap plays it in a popup with our control bar right under it
// (VideoScreen.js; Android's own full screen had its controls at the bottom of the screen). (Phone reason
// for not copying the web page's player in the message: the message's long-press Pressable takes the
// touches, so the player's own controls never got them; the popup is a window of its own.)
// expo-video's player (Android's ExoPlayer) downloads with its own HTTP client, which doesn't send
// React Native's login cookie, so we give it the cookie as a header (modules/cookies). It fetches the
// video in pieces as it plays; until play is pressed, only enough for the first picture.
function VideoAttachment({ file, sender, onLongPress }) {
  const styles = useStyles(makeStyles);
  // useMemo: the same source object at every redraw (a new one would make a new player).
  const source = useMemo(() => {
    const cookie = getCookie(SERVER);
    return { uri: `${SERVER}/uploads/${encodeURIComponent(file.id)}`, headers: cookie ? { Cookie: cookie } : undefined };
  }, [file.id]);
  const player = useVideoPlayer(source);  // one player per video message, for its first picture; never plays
  const [watching, setWatching] = useState(false);  // the popup is open (with a player of its own)
  const [natural, setNatural] = useState(null);  // the video's own {width, height}, once it has loaded
  const [room, setRoom] = useState(400);          // how wide it may be here
  useEventListener(player, 'sourceLoad', ({ availableVideoTracks }) => {
    const size = availableVideoTracks[0]?.size;
    if (size?.width && size?.height) setNatural(size);
  });
  // Until we know the video's shape, a 16:9 box (most videos are).
  const width = Math.min(room, 400);
  let size = { width, height: Math.min(300, (width * 9) / 16) };
  if (natural) {
    const scale = Math.min(width / natural.width, 300 / natural.height);
    size = { width: natural.width * scale, height: natural.height * scale };
  }
  return (
    <View>
      <View style={styles.fitted} onLayout={(event) => setRoom(event.nativeEvent.layout.width)}>
        <View>
          {/* surfaceType "textureView": drawn as part of the screen like everything else. The default (a
              SurfaceView) is a separate layer, which Android's stretch at the end of a list didn't move with. */}
          <VideoView
            player={player} style={[size, styles.attachmentImage, styles.video]} nativeControls={false} contentFit="contain"
            surfaceType="textureView"
          />
          {/* A see-through button over the whole video, with the play button in its middle. It has to lie
              on top: Android's video view took taps on it for itself, so a Pressable around it never
              heard of them. */}
          <Pressable
            style={[styles.videoCover, size]}
            onPress={() => setWatching(true)}
            onLongPress={onLongPress}
          >
            <View style={styles.playButton}>
              <Icon name="play" size={28} color="#ffffff" />
            </View>
          </Pressable>
        </View>
      </View>
      <FileAttachment file={file} sender={sender} onLongPress={onLongPress} />
      {watching ? <VideoScreen path={`/uploads/${encodeURIComponent(file.id)}`} onClose={() => setWatching(false)} /> : null}
    </View>
  );
}

// A file that isn't a picture. Like the desktop app: a tap asks first ("Download this file?", with a
// warning when someone else sent it), then downloads it with a progress bar under the name, saves it
// in the phone's Download folder (like a browser), and offers to open it (in an app that can).
function FileAttachment({ file, sender, onLongPress }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [progress, setProgress] = useState(null);  // 0..1 while downloading, else null

  function ask() {
    if (progress !== null) return;  // already downloading
    const sentBy = sender === null ? 'Sent by you.' : `Sent by ${sender}.`;
    const warning = sender === null ? '' : "\n\nOnly open files from people you trust: a file can harm your phone.";
    Alert.alert('Download this file?', `${file.filename} (${formatSize(file.size)})\n${sentBy}${warning}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Download', onPress: download },
    ]);
  }

  async function download() {
    setProgress(0);
    let saved;
    try {
      saved = await saveFile(file, await downloadFile(file, setProgress));
    } catch (error) {
      Alert.alert("Couldn't download the file", error.message);
      return;
    } finally {
      setProgress(null);
    }
    Alert.alert('Saved to Download', `as ${saved.name}`, [
      { text: 'Close', style: 'cancel' },
      {
        text: 'Open',
        onPress: async () => {
          if (!(await openFile(saved.uri, saved.type))) {
            Alert.alert('No app on this phone can open this file.', "It's in your Download folder.");
          }
        },
      },
    ]);
  }

  return (
    <Pressable onPress={ask} onLongPress={onLongPress} style={({ pressed }) => [styles.attachmentFile, pressed && styles.attachmentPressed]}>
      <View style={styles.attachmentRow}>
        <Icon name={file.video ? 'video' : 'file'} size={16} color={colors.link} />
        <Text style={styles.attachmentName}>{file.filename} ({formatSize(file.size)})</Text>
      </View>
      {progress !== null ? (
        // The web page's <progress>: a groove, filled as far as it's come.
        <View style={styles.progress}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      ) : null}
    </Pressable>
  );
}

// A link's preview card (the web page's makePreviewCard): the site, the title (a link), a
// description and a picture, all fetched by our server; the picture comes from our server too.
export function LinkPreview({ preview }) {
  const styles = useStyles(makeStyles);
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
const makeStyles = (colors, size) => StyleSheet.create({
  text: { fontSize: size(16), lineHeight: size(22), color: colors.text },
  note: { color: colors.textMuted, fontStyle: 'italic' },
  jumbo: { fontSize: size(41.6), lineHeight: size(50) },
  // .jumbo: emoji at 2.6rem; pictures 48 px; all centred on one line, wrapping when there are many.
  jumboRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  jumboText: { fontSize: size(41.6), color: colors.text },
  edited: { fontSize: size(11.2), color: colors.textMuted, fontStyle: 'normal' },
  bold: { fontWeight: 'bold' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { color: colors.link },
  mention: { backgroundColor: colors.accent30, color: colors.mentionText, fontWeight: '500' },
  // `code` and code blocks: monospace at 0.875em, on the panel colour.
  code: { fontFamily: 'monospace', fontSize: size(14), backgroundColor: colors.bgPanel },
  codeBlock: {
    marginVertical: 4, padding: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bgPanel,
  },
  codeBlockText: { fontFamily: 'monospace', fontSize: size(14), lineHeight: size(20), color: colors.text },
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
  video: { backgroundColor: colors.bgDarkest, overflow: 'hidden' },  // dark until the first picture shows
  // Over the video (marginTop: the video's own 4), the play button centred in it.
  videoCover: { position: 'absolute', top: 4, left: 0, alignItems: 'center', justifyContent: 'center' },
  playButton: {
    width: 56, height: 56, borderRadius: 28, paddingLeft: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.6)', alignItems: 'center', justifyContent: 'center',
  },
  // .attachment-file: a box on the panel colour, the name in the link colour.
  attachmentFile: {
    alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    backgroundColor: colors.bgPanel,
  },
  attachmentPressed: { opacity: 0.7 },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  attachmentName: { flexShrink: 1, color: colors.link, fontSize: size(16) },
  // Its progress bar: 4px, the link colour on the darkest one.
  progress: { height: 4, marginTop: 6, borderRadius: 2, backgroundColor: colors.bgDarkest, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.link },
  // .link-preview: a card with a 4px line on its left.
  preview: {
    maxWidth: 432, marginTop: 6, paddingTop: 10, paddingHorizontal: 14, paddingBottom: 12, gap: 4,
    borderLeftWidth: 4, borderLeftColor: colors.border, borderRadius: 4, backgroundColor: colors.bgPanel,
  },
  previewSite: { fontSize: size(12), color: colors.textSoft },
  previewTitle: { fontWeight: '600', color: colors.link, fontSize: size(16) },
  previewDescription: { fontSize: size(13.6), color: colors.text },
  previewImage: { marginTop: 6, borderRadius: 4 },
});
