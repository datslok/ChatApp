// The web app's default (dark) theme, from the top of static/css/chat.css, named by role the same way.
export const colors = {
  bgDarkest: '#1e1f22',  // text fields
  bgPanel: '#2b2d31',    // the channel list
  bgMain: '#313338',     // the messages
  bgActive: '#404249',   // a pressed row
  textStrong: '#ffffff', // names, headings
  text: '#dbdee1',       // messages and most text
  textSoft: '#b5bac1',   // channel names
  textMuted: '#949ba4',  // times, hints, section headings
  textFaint: '#80848e',  // the offline dot
  accent: '#5865f2',     // buttons
  accentFaint: 'rgba(88, 101, 242, 0.3)',  // behind an @mention (the accent at 30%)
  mentionText: '#c9cdfb', // the text of an @mention
  red: '#f23f43',        // errors, unread counts, do not disturb
  green: '#23a55a',      // online
  buttonGreen: '#248046', // accept
  yellow: '#f0b232',     // idle, mentions of you
  yellowFaint: 'rgba(240, 178, 50, 0.08)',  // behind a message that mentions you
  bgNeutral: '#4e5058',  // grey buttons (Remove, Cancel)
};

// The status dot's colour: what the others see of someone (the server's "presence").
export const presenceColors = {
  online: colors.green,
  idle: colors.yellow,
  dnd: colors.red,
  offline: colors.textFaint,
};
