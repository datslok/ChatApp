// The little dot showing someone's status: online, idle, do not disturb or offline.
import { StyleSheet, View } from 'react-native';
import { presenceColors } from './colors';

export default function StatusDot({ user }) {
  const color = presenceColors[user?.presence] ?? presenceColors.offline;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
});
