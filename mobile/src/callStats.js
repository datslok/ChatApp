// How the call's connection is doing (the web page's voice.js, "Connection quality"): measured every
// STATS_SECONDS while in a call, for the signal bars in the voice bar and the popup with the details
// (ConnectionScreen.js).
//
// WebRTC keeps statistics on every connection, and LiveKit lets us read them per track
// (getRTCStatsReport: react-native-webrtc's getStats() for that track, a Map of "stats" objects, each
// with a "type"):
//   - ping: the route the sound takes to our LiveKit server ("candidate-pair") knows how long a packet
//     takes there and back (currentRoundTripTime, in seconds)
//   - UDP or TCP: that route's own end ("local-candidate"); TCP is LiveKit's fallback
//   - outbound packet loss: what we sent ("outbound-rtp") against what the server says never arrived
//     ("remote-inbound-rtp": its regular reports back to us)
//   - inbound packet loss: of the others' voices, what never reached us ("inbound-rtp")
// The counters only ever go up, so the loss is worked out from the difference with last time: what's
// happening now, not an average since joining. Screen shares: the same numbers for video.
import { Track } from 'livekit-client';

export const STATS_SECONDS = 5;    // how often we measure
export const GRAPH_SECONDS = 300;  // how far back the graph goes: 5 minutes

// react-native-webrtc's report as a Map (it gives a Map; an array of [id, stat] pairs just in case).
function asMap(report) {
  if (!report) return null;
  return report instanceof Map ? report : new Map(Array.isArray(report) ? report : Object.entries(report));
}

// The route a report's packets take: its ping (ms) and "udp" or "tcp". Or null.
function routeOf(report) {
  if (!report) return null;
  let pair = null;
  for (const stat of report.values()) {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId);
  }
  if (!pair) {  // (not said which one is selected: the one that's working)
    for (const stat of report.values()) {
      if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') pair = stat;
    }
  }
  if (!pair || pair.currentRoundTripTime === undefined) return null;
  const local = report.get(pair.localCandidateId);
  return { ping: Math.round(pair.currentRoundTripTime * 1000), protocol: local ? local.protocol : null };
}

// Lost packets as a % of all of them, since the last measurement. null if nothing was sent.
function lossPercent(lost, total, lastLost, lastTotal) {
  if (lastTotal === undefined) return null;      // the first measurement: nothing to compare with
  const newLost = Math.max(0, lost - lastLost);  // (Math.max: duplicates can make it count down)
  const newTotal = total - lastTotal;
  if (newTotal <= 0) return null;  // muted, nobody talking, or someone left
  return Math.min(100, (newLost / newTotal) * 100);
}

async function reportOf(track) {
  return track ? asMap(await track.getRTCStatsReport()) : null;
}

// One measurement. previous: what the last one returned (its counters), or null. Returns
// {ping, protocol, outLoss, inLoss, screens: {sending, watching}, counts}, or null if the room changed
// shape while we asked (a track went away): next time.
export async function measureCall(room, previous) {
  let sending = null;
  const receiving = [];
  try {
    sending = await reportOf(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track);
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) receiving.push(await reportOf(publication.track));
      }
    }
  } catch {
    return null;
  }
  const counts = { sent: 0, lostOut: 0, received: 0, lostIn: 0, screens: new Map() };
  for (const stat of sending ? sending.values() : []) {
    if (stat.type === 'outbound-rtp') counts.sent += stat.packetsSent || 0;
    if (stat.type === 'remote-inbound-rtp') counts.lostOut += stat.packetsLost || 0;
  }
  for (const report of receiving) {
    for (const stat of report ? report.values() : []) {
      if (stat.type === 'inbound-rtp') {
        counts.received += stat.packetsReceived || 0;
        counts.lostIn += stat.packetsLost || 0;
      }
    }
  }
  const last = previous?.counts ?? {};
  const route = routeOf(sending) || receiving.map(routeOf).find(Boolean) || null;
  const screens = await measureScreens(room, last.screens ?? new Map(), counts.screens);
  if (!screens) return null;
  return {
    ping: route ? route.ping : null,
    protocol: route ? route.protocol : null,
    outLoss: lossPercent(counts.lostOut, counts.sent, last.lostOut, last.sent),
    // (Received plus lost: everything that was sent to us.)
    inLoss: lossPercent(counts.lostIn, counts.received + counts.lostIn, last.lostIn,
      last.received === undefined ? undefined : last.received + last.lostIn),
    screens,
    counts,
  };
}

// Screen shares: how the one we send is doing, and the ones we watch.
async function measureScreens(room, lastCounts, counts) {
  let sending = null;
  const watching = [];
  try {
    const mine = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (mine?.track) sending = videoStats(await reportOf(mine.track), 'outbound-rtp', 'out', lastCounts, counts);
    for (const participant of room.remoteParticipants.values()) {
      const theirs = participant.getTrackPublication(Track.Source.ScreenShare);
      if (!theirs?.track) continue;  // not sharing, or we aren't receiving it
      const key = 'in:' + participant.identity;
      const stats = videoStats(await reportOf(theirs.track), 'inbound-rtp', key, lastCounts, counts);
      if (stats) watching.push({ userId: Number(participant.identity), ...stats });
    }
  } catch {
    return null;
  }
  return { sending, watching };
}

// One stream's numbers (the web page's videoStats): the counters add up all of a share's streams, the
// rest is about the biggest one.
function videoStats(report, type, key, lastCounts, counts) {
  if (!report) return null;
  let main = null;
  const now = { time: Date.now(), bytes: 0, packets: 0, lost: 0, dropped: 0, freezes: 0 };
  for (const stat of report.values()) {
    if (stat.type !== type || stat.kind !== 'video') continue;
    now.bytes += (stat.bytesSent ?? stat.bytesReceived) || 0;
    now.packets += (stat.packetsSent ?? stat.packetsReceived) || 0;
    now.lost += stat.packetsLost || 0;
    now.dropped += stat.framesDropped || 0;
    now.freezes += stat.freezeCount || 0;
    if (!main || (stat.frameHeight || 0) > (main.frameHeight || 0)) main = stat;
  }
  if (!main) return null;
  counts.set(key, now);
  const last = lastCounts.get(key);
  const seconds = last ? (now.time - last.time) / 1000 : 0;
  const codec = report.get(main.codecId);
  return {
    width: main.frameWidth,
    height: main.frameHeight,
    fps: main.framesPerSecond,
    mbps: seconds > 0 ? ((now.bytes - last.bytes) * 8) / seconds / 1e6 : null,  // megabits a second
    codec: codec?.mimeType ? codec.mimeType.replace('video/', '') : null,
    implementation: main.encoderImplementation ?? main.decoderImplementation ?? null,
    limitedBy: main.qualityLimitationReason ?? null,
    loss: type === 'inbound-rtp' && last ? lossPercent(now.lost, now.packets + now.lost, last.lost, last.packets + last.lost) : null,
    dropped: last ? now.dropped - last.dropped : null,
    freezes: last ? now.freezes - last.freezes : null,
  };
}

// "good" (green), "fair" (yellow) or "bad" (red), like Discord's signal icon (and the web page's).
export function connectionQuality(stats) {
  const ping = stats.ping ?? 0;
  const loss = Math.max(stats.outLoss ?? 0, stats.inLoss ?? 0);
  if (ping >= 250 || loss >= 10) return 'bad';
  if (ping >= 100 || loss >= 2) return 'fair';
  return 'good';
}
