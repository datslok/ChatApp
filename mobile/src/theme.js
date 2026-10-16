// The colours and text size (Settings → Appearance), the app's version of the web page's chat.css
// variables and appearance.js.
//
// On the web page every colour is a CSS variable, so a new theme repaints everything by itself. React
// Native has no such thing, so the app does it the React way: the current theme lives in a *context*
// (a value every component can read without it being passed down through every prop), and each file
// makes its styles with a function of it:
//
//   const makeStyles = (colors, size) => StyleSheet.create({ title: { color: colors.text, fontSize: size(16) } });
//   ...inside a component:  const styles = useStyles(makeStyles);
//
// When the theme changes, every component that reads it draws again with the new styles; nothing
// reloads. The appearance is kept with the account (users.appearance: "welcome" brings it, and
// "appearance" after a change on any device), and a copy in a file on the phone, so the app starts in
// your theme before it has even connected (the web page keeps that copy in localStorage).
import { File, Paths } from 'expo-file-system';
import { createContext, useContext } from 'react';

// ----- The themes (chat.css, the top): Dark has every colour, the others only what differs.

// Dark, the default, each named after its CSS variable (--bg-panel -> bgPanel).
const DARK = {
  bgDeepest: '#111214',   // behind calls
  bgDarkest: '#1e1f22',   // text fields, cards
  bgPanelAlt: '#232428',  // popups, your panel at the bottom of the sidebar
  bgPanel: '#2b2d31',     // the sidebars, chips
  bgMain: '#313338',      // the messages
  bgHoverDim: '#2e3035',  // a message being pressed
  bgHover: '#35373c',     // a channel or person being pressed
  bgActive: '#404249',    // the chat you're in
  bgInput: '#383a40',     // the message box
  bgNeutral: '#4e5058',   // grey buttons, a group's picture
  border: '#1e1f22',      // under the top bar, around popups
  line: '#3f4147',        // dividers between things
  textStrong: '#ffffff',  // headings, names, the selected thing
  text: '#dbdee1',        // messages and most text
  textSoft: '#b5bac1',    // labels, secondary text
  textMuted: '#949ba4',   // times, hints, section headings
  textFaint: '#80848e',   // the offline dot
  accent: '#5865f2',      // buttons, mentions, your own reactions
  mentionText: '#c9cdfb', // the text of an @mention
  link: '#00a8fc',
  green: '#23a55a',       // online
  buttonGreen: '#248046', // join, accept, Invite someone
  red: '#f23f43',         // errors, unread counts, do not disturb
  buttonRed: '#da373c',
  yellow: '#f0b232',      // idle, mentions of you
  botBadgeText: '#ffffff',
};

const THEMES = {
  dark: {},
  darker: {
    bgDeepest: '#000000', bgDarkest: '#0b0b0d', bgPanelAlt: '#0f0f11', bgPanel: '#111214', bgMain: '#18191c',
    bgHoverDim: '#1d1e21', bgHover: '#232428', bgActive: '#2b2d31', bgInput: '#222327', bgNeutral: '#3a3c42',
    border: '#000000', line: '#2b2d31',
  },
  light: {
    bgDeepest: '#e3e5e8', bgDarkest: '#ebedef', bgPanelAlt: '#ebedef', bgPanel: '#f2f3f5', bgMain: '#ffffff',
    bgHoverDim: '#f5f6f7', bgHover: '#e3e5e8', bgActive: '#d4d7dc', bgInput: '#ebedef', bgNeutral: '#6d6f78',
    border: '#d4d7dc', line: '#e3e5e8',
    textStrong: '#060607', text: '#313338', textSoft: '#4e5058', textMuted: '#5c5e66', textFaint: '#80848e',
    // A little deeper than in Dark, to stay readable on white.
    mentionText: '#3c45a5', link: '#006ce7', green: '#1e8e4e', red: '#d83a42', yellow: '#b97d0c',
  },
  blue: {
    bgDeepest: '#0b1220', bgDarkest: '#0f1a2e', bgPanelAlt: '#13203a', bgPanel: '#172540', bgMain: '#1c2c4a',
    bgHoverDim: '#1a2945', bgHover: '#233558', bgActive: '#2b3f66', bgInput: '#22355a', bgNeutral: '#3d5078',
    border: '#0f1a2e', line: '#2b3f66',
  },
  purple: {
    bgDeepest: '#130d1c', bgDarkest: '#1a1226', bgPanelAlt: '#1f162e', bgPanel: '#251a36', bgMain: '#2c2040',
    bgHoverDim: '#291e3c', bgHover: '#34264b', bgActive: '#3e2e59', bgInput: '#372a4f', bgNeutral: '#54456e',
    border: '#1a1226', line: '#3e2e59',
  },
  green: {
    bgDeepest: '#0b1510', bgDarkest: '#0f1c16', bgPanelAlt: '#13221b', bgPanel: '#17291f', bgMain: '#1c3026',
    bgHoverDim: '#1a2d23', bgHover: '#22392d', bgActive: '#2a4536', bgInput: '#253e31', bgNeutral: '#3f5a4b',
    border: '#0f1c16', line: '#2a4536',
  },
  pink: {
    bgDeepest: '#1a0d15', bgDarkest: '#22111c', bgPanelAlt: '#281420', bgPanel: '#2f1826', bgMain: '#381d2d',
    bgHoverDim: '#331a29', bgHover: '#432436', bgActive: '#4f2b40', bgInput: '#46263a', bgNeutral: '#6a4058',
    border: '#22111c', line: '#4f2b40',
    accent: '#eb459e', mentionText: '#f9c6e0',  // the only dark theme with its own accent
  },
  // Like Light (dark text on light backgrounds), in pastel pink, with a pink accent.
  lightpink: {
    bgDeepest: '#e9bfd3', bgDarkest: '#f0cfdf', bgPanelAlt: '#f0cfdf', bgPanel: '#f5d9e6', bgMain: '#fae6ef',
    bgHoverDim: '#f6dce8', bgHover: '#edc7d9', bgActive: '#e6b5cc', bgInput: '#f0cfdf', bgNeutral: '#8a6878',
    border: '#e6b5cc', line: '#e9bfd3',
    textStrong: '#2a0f1d', text: '#3d2230', textSoft: '#5e4250', textMuted: '#7a5c6b', textFaint: '#9a7f8c',
    accent: '#d63384', mentionText: '#8e1f57', link: '#c2185b', green: '#1e8e4e', red: '#d83a42', yellow: '#b97d0c',
  },
};

// Settings → Appearance's swatches, in the web page's order and with its names.
export const THEME_CHOICES = [
  ['dark', 'Dark'], ['darker', 'Darker'], ['light', 'Light'], ['blue', 'Blue'],
  ['purple', 'Purple'], ['green', 'Green'], ['pink', 'Pink'], ['lightpink', 'Light pink'],
];

// The colours you can pick by hand (server.py's APPEARANCE_COLOURS), with the web page's labels.
export const PICKABLE_COLOURS = [
  ['bg-main', 'Background'], ['bg-panel', 'Panels'], ['text', 'Text'],
  ['text-muted', 'Faded text'], ['accent', 'Accent'], ['link', 'Links'],
];

// The letter circles' colours, for people without a picture: each person always gets the same one
// (their id picks it), as on the web page (people.js, LETTER_COLOURS). The same in every theme.
export const letterColors = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c'];

export const DEFAULT_APPEARANCE = { theme: 'dark', colours: {}, font: 'system', font_size: 16, scale: 100 };

// The web page's fonts (appearance.js, APPEARANCE_FONTS) as Android has them. Its choices are Windows'
// fonts; Android's own come close for three: its serif (Noto Serif) for Georgia, its monospace (Droid Sans
// Mono) for Consolas, and "casual" (Coming Soon, a handwriting font) for Comic Sans. Calibri has none,
// so it stays the phone's own font, like System. (undefined: the phone's font, Roboto or Samsung's.)
export const FONT_FAMILIES = {
  system: undefined, calibri: undefined, georgia: 'serif', consolas: 'monospace', comic: 'casual',
};

// Settings → Appearance's choices, with the web page's names.
export const FONT_CHOICES = [
  ['system', 'System'], ['calibri', 'Calibri'], ['georgia', 'Georgia'], ['consolas', 'Consolas'], ['comic', 'Comic Sans'],
];

// "bg-panel" -> "bgPanel"
const camel = (name) => name.replace(/-(\w)/g, (whole, letter) => letter.toUpperCase());

// "#5865f2" -> [88, 101, 242]
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A colour at some opacity: rgba("#5865f2", 0.15) -> "rgba(88, 101, 242, 0.15)" (chat.css's color-mix).
function rgba(hex, alpha) {
  return `rgba(${rgb(hex).join(', ')}, ${alpha})`;
}

// ----- Icons must stay readable (appearance.js, guardIconColours)
//
// Icons are lines in a text colour, so they're only as easy to see as that colour is against what's
// behind them. The themes are made for that, but colours picked by hand may not be (grey text on a grey
// panel). "Contrast ratio" is how accessibility guidelines (WCAG) measure it: from 1 (the same colour)
// to 21 (black on white). Icons need 3 or more; below that, another colour is used for them.
const ICON_CONTRAST = 3;

// How bright a colour looks (0 for black to 1 for white): each channel turned back into real light
// (screens store it "gamma-encoded"), weighted by how sensitive the eye is to it.
function luminance(hex) {
  const light = (channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * light(r) + 0.7152 * light(g) + 0.0722 * light(b);
}

function contrastRatio(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

// The first of these colours that's clear on every background icons sit on; none: white or black.
function readable(candidates, backgrounds) {
  const worst = (colour) => Math.min(...backgrounds.map((background) => contrastRatio(colour, background)));
  for (const colour of candidates) {
    if (worst(colour) >= ICON_CONTRAST) return colour;
  }
  return worst('#ffffff') >= worst('#000000') ? '#ffffff' : '#000000';
}

// ----- A whole theme from an appearance: {appearance, colors, size, light, presence, font}

export function makeTheme(saved) {
  const appearance = { ...DEFAULT_APPEARANCE, ...saved };
  const colors = { ...DARK, ...(THEMES[appearance.theme] ?? {}) };
  // Colours picked by hand go on top of the theme's (only real ones: the server checked them, the
  // file on the phone might be old).
  for (const [name, colour] of Object.entries(appearance.colours ?? {})) {
    if (/^#[0-9a-fA-F]{6}$/.test(colour) && camel(name) in colors) colors[camel(name)] = colour;
  }
  // The ones that follow others (chat.css: var(--accent) and color-mix with it).
  colors.botBadge = colors.accent;
  colors.accent15 = rgba(colors.accent, 0.15);  // behind your own reaction
  colors.accent30 = rgba(colors.accent, 0.3);   // behind an @mention
  colors.accent35 = rgba(colors.accent, 0.35);  // a message lighting up after a jump to it
  colors.yellow8 = rgba(colors.yellow, 0.08);   // behind a message that mentions you
  const backgrounds = [colors.bgPanelAlt, colors.bgPanel, colors.bgMain, colors.bgInput];
  colors.icon = readable([colors.textMuted, colors.textSoft, colors.text], backgrounds);
  colors.iconStrong = readable([colors.textStrong, colors.text], backgrounds);

  // The text size: 12 to 20, like the web page's (16 is normal). The app's sizes are written as the
  // web page's at 16 (1rem = 16 px), and size() scales them: size(16) is 18 at text size 18.
  const scale = (appearance.font_size || 16) / 16;
  const size = (n) => Math.round(n * scale * 10) / 10;

  // The status dot's colour, by what the others see of someone.
  const presence = {
    online: colors.green, idle: colors.yellow, dnd: colors.red, offline: colors.textFaint, invisible: colors.textFaint,
  };
  // A light theme (by its background): the phone's status bar then needs dark icons.
  const light = luminance(colors.bgMain) > 0.5;
  const font = FONT_FAMILIES[appearance.font];
  return { appearance, colors, size, light, presence, font };
}

// ----- Kept on the phone too, for the first drawing (before the server has said anything).

const savedFile = new File(Paths.document, 'appearance.json');

// Read straight away (synchronously: before anything is drawn). Nothing saved, or unreadable: the defaults.
export function loadAppearance() {
  try {
    if (savedFile.exists) return JSON.parse(savedFile.textSync());
  } catch {}
  return DEFAULT_APPEARANCE;
}

export function saveAppearance(appearance) {
  try {
    if (!savedFile.exists) savedFile.create();
    savedFile.write(JSON.stringify(appearance));
  } catch {}  // (just no copy for next time)
}

// ----- The context and its hooks

// What every component can read: the theme, and setAppearance(appearance) to change it (App.js gives it).
export const ThemeContext = createContext({ ...makeTheme(DEFAULT_APPEARANCE), setAppearance: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

// A file's styles for the current theme: makeStyles(colors, size) runs once per theme and the
// result is kept (a WeakMap: when a theme is no longer used, its styles can be thrown away too), so
// the hundreds of message rows that ask for the same styles share one copy.
const styleCache = new WeakMap();

// The chosen font, put into every style that has a text size (the web page sets it once, on the
// whole page, with --font; React Native has no such thing, and a font is per Text). So the files' own
// styles needn't think about it: they're written as before, and this adds `fontFamily` to each one
// with a fontSize, unless it has its own (code is monospace whatever the font).
function withFont(styles, font) {
  if (!font) return styles;
  const result = {};
  for (const [name, style] of Object.entries(styles)) {
    result[name] = style && style.fontSize !== undefined && style.fontFamily === undefined ? { ...style, fontFamily: font } : style;
  }
  return result;
}

export function useStyles(makeStyles) {
  const theme = useTheme();
  let made = styleCache.get(theme);
  if (!made) {
    made = new Map();
    styleCache.set(theme, made);
  }
  if (!made.has(makeStyles)) made.set(makeStyles, withFont(makeStyles(theme.colors, theme.size), theme.font));
  return made.get(makeStyles);
}
