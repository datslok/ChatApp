// The web app's colours, from the top of static/css/chat.css: its default (dark) theme, each named
// after its CSS variable (--bg-panel -> bgPanel). Settings → Appearance's other themes come later,
// as more sets of the same names.
export const colors = {
  bgDeepest: '#111214',
  bgDarkest: '#1e1f22',   // text fields, cards
  bgPanelAlt: '#232428',  // popups, your panel at the bottom of the sidebar
  bgPanel: '#2b2d31',     // the sidebars, chips
  bgMain: '#313338',      // the messages
  bgHoverDim: '#2e3035',  // a message being pressed
  bgHover: '#35373c',     // a channel or person being pressed
  bgActive: '#404249',    // the chat you're in
  bgInput: '#383a40',     // the message box
  bgNeutral: '#4e5058',   // grey buttons, a group's picture
  line: '#3f4147',        // dividers between things
  border: '#1e1f22',      // under the top bar, around popups
  textStrong: '#ffffff',  // headings, names, the selected thing
  text: '#dbdee1',        // messages and most text
  textSoft: '#b5bac1',    // labels, secondary text
  textMuted: '#949ba4',   // times, hints, section headings
  textFaint: '#80848e',   // the offline dot
  icon: '#949ba4',        // plain icon buttons (--icon: the muted text colour)
  iconStrong: '#ffffff',
  accent: '#5865f2',      // buttons, mentions, your own reactions
  accent15: 'rgba(88, 101, 242, 0.15)',  // behind your own reaction (the accent at 15%)
  accent30: 'rgba(88, 101, 242, 0.3)',   // behind an @mention (the accent at 30%)
  accent35: 'rgba(88, 101, 242, 0.35)',  // a message lighting up after a jump to it
  mentionText: '#c9cdfb', // the text of an @mention
  link: '#00a8fc',
  green: '#23a55a',       // online
  buttonGreen: '#248046', // the call button
  red: '#f23f43',         // errors, unread counts, do not disturb
  buttonRed: '#da373c',
  yellow: '#f0b232',      // idle, mentions of you
  yellow8: 'rgba(240, 178, 50, 0.08)',   // behind a message that mentions you
  botBadge: '#5865f2',    // the "BOT" tag (the theme's accent)
  botBadgeText: '#ffffff',
};

// The status dot's colour: what the others see of someone (the server's "presence").
export const presenceColors = {
  online: colors.green,
  idle: colors.yellow,
  dnd: colors.red,
  offline: colors.textFaint,
  invisible: colors.textFaint,  // (only we see our own Invisible: drawn as a ring)
};

// The letter circles' colours, for people without a picture: each person always gets the same one
// (their id picks it), as on the web page (people.js, LETTER_COLOURS).
export const letterColors = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c'];
