// A line icon, the same as on the web page's buttons (Lucide's shapes, from icon-shapes.js).
//
// React Native can't draw SVG by itself; react-native-svg can. Its SvgXml draws SVG written as text,
// which is exactly how icon-shapes.js keeps the shapes, so we wrap them in an <svg> like the web
// page's icons.js does, with chat.css's .icon look: lines in one colour, 1.8 thick, round ends.
import { SvgXml } from 'react-native-svg';
import { useTheme } from './theme';
import { ICON_SHAPES } from './icon-shapes';

// The smiley on the emoji buttons is the web page's own drawing (messages.js, makeSmileyIcon), not
// Lucide's: a circle, a smile, and two filled eyes.
const SMILEY = `<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2"/>`;
const SMILEY_EYES = (color) => `<circle cx="9" cy="10" r="1.2" fill="${color}" stroke="none"/>` +
  `<circle cx="15" cy="10" r="1.2" fill="${color}" stroke="none"/>`;

// color: the lines' colour (the theme's icon colour if none is given).
export default function Icon({ name, size = 20, color }) {
  const { colors } = useTheme();
  color = color ?? colors.icon;
  const shape = name === 'smiley' ? SMILEY + SMILEY_EYES(color) : ICON_SHAPES[name] ?? '';
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
  return <SvgXml xml={xml} width={size} height={size} />;
}
