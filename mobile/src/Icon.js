// A line icon, the same as on the web page's buttons (Lucide's shapes, from icon-shapes.js).
//
// React Native can't draw SVG by itself; react-native-svg can. Its SvgXml draws SVG written as text,
// which is exactly how icon-shapes.js keeps the shapes, so we wrap them in an <svg> like the web
// page's icons.js does, with chat.css's .icon look: lines in one colour, 1.8 thick, round ends.
import { SvgXml } from 'react-native-svg';
import { colors } from './colors';
import { ICON_SHAPES } from './icon-shapes';

export default function Icon({ name, size = 20, color = colors.icon }) {
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_SHAPES[name] ?? ''}</svg>`;
  return <SvgXml xml={xml} width={size} height={size} />;
}
