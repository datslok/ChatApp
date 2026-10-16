// The seasonal easter egg (the web page's people.js, "The seasonal easter egg"): during a season (the
// server's "season" in "welcome": Halloween in October, Christmas in December) its emoji sits on the
// corner of our own picture in the sidebar's panel, or for Christmas a Santa hat on top of it, and a
// tap plays the season's video in a popup.
import { Pressable, StyleSheet, Text } from 'react-native';
import { SvgUri } from 'react-native-svg';
import VideoScreen from './VideoScreen';
import { SERVER } from './config';
import { useStyles } from './theme';

// The emoji (or hat) on our picture. A Pressable of its own inside the panel's: it takes the tap first,
// so the panel's own (your popup) doesn't open too. Placed in a box with 4px of room around the picture
// (Sidebar.js), so more of it lies inside its parent's edges: Android ignores taps outside them.
export function SeasonBadge({ season, onPress }) {
  const styles = useStyles(makeStyles);
  if (season.image) {
    // .season-hat: 34px wide, a little above the picture, tilted as if it sits there. (react-native-svg
    // draws the SVG, which React Native's Image can't; /static/ needs no login.)
    return (
      <Pressable onPress={onPress} hitSlop={6} style={styles.hat} accessibilityLabel="Seasonal surprise">
        <SvgUri uri={SERVER + season.image} width={34} height={29} />
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.badge} accessibilityLabel="Seasonal surprise">
      <Text style={styles.emoji}>{season.emoji}</Text>
    </Pressable>
  );
}

// The season's video (30% volume at first, like every video; VideoScreen remembers it).
export default function SeasonScreen({ season, onClose }) {
  return <VideoScreen path={season.video} onClose={onClose} />;
}

const makeStyles = (colors, size) => StyleSheet.create({
  // .season-badge: on the picture's top left corner (8px over its edges), 1rem, with a little shadow.
  badge: { position: 'absolute', top: -4, left: -4 },
  emoji: {
    fontSize: size(16), lineHeight: size(18),
    textShadowColor: 'rgba(0, 0, 0, 0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1,
  },
  hat: { position: 'absolute', top: -13, left: 0, transform: [{ rotate: '-20deg' }] },
});
