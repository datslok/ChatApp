// The call's connection: the signal bars in the voice bar (green, yellow or red by ping and loss), and the
// popup a tap on them opens (the web page's #voice-signal and #voice-stats): a graph of the ping over the
// last 5 minutes, the server, UDP or TCP, the pings, the packet loss both ways, and the screen shares we
// send or watch. The numbers come from voice.js (callStats.js measures them every 5 seconds).
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { Popup } from './MessageCard';
import { GRAPH_SECONDS, connectionQuality } from './callStats';
import { clock } from './time';
import { useStyles, useTheme } from './theme';

// Three bars, the web page's own drawing (16 × 16), coloured by the quality. Nothing until the first ping.
export function SignalButton({ voice }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const stats = voice.stats;
  if (!stats || stats.ping === null) return null;
  const colour = { good: colors.green, fair: colors.yellow, bad: colors.red }[connectionQuality(stats)];
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={10} accessibilityLabel={`Ping ${stats.ping} ms: connection details`}>
        <Svg width={16} height={16} viewBox="0 0 16 16">
          <Rect x={1} y={10} width={3.5} height={5} rx={1} fill={colour} />
          <Rect x={6.25} y={6} width={3.5} height={9} rx={1} fill={colour} />
          <Rect x={11.5} y={2} width={3.5} height={13} rx={1} fill={colour} />
        </Svg>
      </Pressable>
      {open ? <ConnectionPopup voice={voice} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const PROTOCOLS = { udp: 'UDP (direct)', tcp: 'TCP (fallback)' };
const REASONS = { none: 'nothing', cpu: 'the phone (too slow)', bandwidth: 'the connection', other: 'something else' };

function ConnectionPopup({ voice, onClose }) {
  const styles = useStyles(makeStyles);
  const stats = voice.stats;
  const samples = voice.pingSamples;
  const percent = (value) => (value === null || value === undefined ? '–' : value.toFixed(1) + '%');
  const average = samples.length
    ? Math.round(samples.reduce((sum, sample) => sum + sample.ping, 0) / samples.length) + ' ms' : '–';
  const line = (label, value) => (
    <Text key={label} style={styles.line}>{label}: <Text style={styles.value}>{value}</Text></Text>
  );
  return (
    <Popup title="Connection" onClose={onClose}>
      <ScrollView>
        <PingGraph samples={samples} />
        <Text style={styles.server}>{voice.server}</Text>
        {line('Connection', PROTOCOLS[stats?.protocol] ?? '–')}
        {line('Average ping', average)}
        {line('Last ping', stats?.ping == null ? '–' : stats.ping + ' ms')}
        {line('Outbound packet loss', percent(stats?.outLoss))}
        {line('Inbound packet loss', percent(stats?.inLoss))}
        {stats?.screens.sending ? <ScreenBlock title="Your screen share" stats={stats.screens.sending} sending line={line} /> : null}
        {(stats?.screens.watching ?? []).map((screen) => (
          <ScreenBlock
            key={screen.userId} stats={screen} line={line}
            title={`${voice.nameOf(screen.userId)}'s screen`}
          />
        ))}
        <Text style={styles.help}>
          The ping is the time to our voice server and back. You may notice delayed audio at 250 ms or higher,
          and sound robotic with more than 10% outbound packet loss. Inbound loss is what reaches you: if others
          sound robotic and it's high, the problem is on your side. TCP is a fallback when UDP is blocked, and
          handles lost packets worse. Pauses: moments with no new frames, normal when the shared screen isn't
          changing.
        </Text>
      </ScrollView>
    </Popup>
  );
}

// A screen share's numbers (the web page's screenBlock), under a line of its own.
function ScreenBlock({ title, stats, sending, line }) {
  const styles = useStyles(makeStyles);
  const size = stats.width ? `${stats.width}×${stats.height}` : '–';
  const fps = stats.fps === undefined ? '–' : Math.round(stats.fps) + ' fps';
  return (
    <View style={styles.screen}>
      <Text style={styles.screenTitle}>{title}</Text>
      {line('Picture', `${size} at ${fps}`)}
      {line('Data', stats.mbps === null ? '–' : stats.mbps.toFixed(1) + ' Mbit/s')}
      {line(sending ? 'Encoder' : 'Decoder', stats.codec ?? '–')}
      {stats.implementation ? line('Using', stats.implementation) : null}
      {sending ? line('Held back by', REASONS[stats.limitedBy] ?? '–') : null}
      {sending ? null : line('Packet loss', stats.loss === null ? '–' : stats.loss.toFixed(1) + '%')}
      {sending ? null : line('Dropped frames', stats.dropped === null ? '–' : String(stats.dropped))}
      {sending ? null : line('Pauses', stats.freezes === null ? '–' : String(stats.freezes))}
    </View>
  );
}

// The graph (the web page's drawPingGraph): the last 5 minutes from left to right, the ping upwards. Its
// top is a round number a little above the highest ping, with a line and a label at the top, the middle and
// 0, and the time below at each whole minute. Drawn in its own units (260 × 90), scaled to the width.
function PingGraph({ samples }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const plotWidth = 236, plotHeight = 74;
  const now = Date.now();
  const start = now - GRAPH_SECONDS * 1000;
  const highest = Math.max(0, ...samples.map((sample) => sample.ping));
  const top = [10, 20, 50, 100, 200, 500, 1000, 2000].find((step) => highest <= step) ?? Math.ceil(highest / 1000) * 1000;
  const x = (time) => ((time - start) / (GRAPH_SECONDS * 1000)) * plotWidth;
  const y = (ping) => plotHeight - (ping / top) * plotHeight;
  const minutes = [];
  for (let minute = Math.ceil(start / 60000) * 60000; minute <= now; minute += 60000) {
    if (x(minute) >= 14 && x(minute) <= plotWidth - 14) minutes.push(minute);
  }
  const points = samples.map((sample) => `${x(sample.time).toFixed(1)},${y(sample.ping).toFixed(1)}`).join(' ');
  return (
    <View style={styles.graph}>
      <Svg width="100%" height="100%" viewBox="0 0 260 90">
        {[0, top / 2, top].map((value) => (
          <Line key={'grid' + value} x1={0} x2={plotWidth} y1={y(value)} y2={y(value)} stroke={colors.line} strokeWidth={0.5} />
        ))}
        {[0, top / 2, top].map((value) => (
          <SvgText key={'label' + value} x={plotWidth + 4} y={y(value) + 3} fill={colors.textMuted} fontSize={8}>{value}</SvgText>
        ))}
        {minutes.map((minute) => (
          <SvgText key={minute} x={x(minute)} y={88} fill={colors.textMuted} fontSize={8} textAnchor="middle">
            {clock(new Date(minute))}
          </SvgText>
        ))}
        {samples.length > 1 ? (
          <Polyline points={points} fill="none" stroke={colors.accent} strokeWidth={1.5} strokeLinejoin="round" />
        ) : null}
      </Svg>
    </View>
  );
}

const makeStyles = (colors, size) => StyleSheet.create({
  // #ping-graph: the whole width, its own shape (260:90), on the darkest colour.
  graph: { width: '100%', aspectRatio: 260 / 90, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.bgDarkest },
  server: { marginTop: 10, fontWeight: '600', color: colors.textStrong, fontSize: size(13.6) },
  line: { marginVertical: 2, color: colors.text, fontSize: size(13.6) },
  value: { fontWeight: '700' },
  screen: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.line },
  screenTitle: { fontWeight: '600', color: colors.textStrong, fontSize: size(13.6) },
  help: { marginTop: 12, color: colors.textMuted, fontSize: size(12.8) },
});
