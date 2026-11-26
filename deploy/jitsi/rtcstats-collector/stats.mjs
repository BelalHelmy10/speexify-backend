// Pure helpers for the Speexify rtcstats collector.
//
// Jitsi (lib-jitsi-meet) streams each participant's WebRTC getStats() output
// using the rtcstats "3.1_STANDARD" protocol: every poll sends only what
// changed since the previous poll ("delta compression"). These helpers rebuild
// the full stats per peer connection and turn them into the few numbers that
// explain call quality.

/** Merges a delta-compressed getstats payload into the previous full stats. */
export function applyStatsDelta(previous, delta) {
  const next = { ...(previous || {}) };
  if (!delta || typeof delta !== "object") return next;
  const baseTimestamp = Number(delta.timestamp);
  for (const [id, report] of Object.entries(delta)) {
    if (id === "timestamp" || !report || typeof report !== "object") continue;
    const merged = { ...(next[id] || {}), ...report, id };
    // The newest reports carry timestamp 0; the real value is delta.timestamp.
    if (report.timestamp === 0 && Number.isFinite(baseTimestamp)) merged.timestamp = baseTimestamp;
    next[id] = merged;
  }
  return next;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One quality sample from full stats. `previous` is the prior sample's raw
 * counters, used to turn cumulative packet counts into loss rates.
 */
export function sampleFromStats(stats, previousCounters = {}) {
  const reports = Object.values(stats || {});
  const inboundVideo = reports.filter((r) => r.type === "inbound-rtp" && r.kind === "video");
  const outboundVideo = reports.filter((r) => r.type === "outbound-rtp" && r.kind === "video");
  const inboundAudio = reports.filter((r) => r.type === "inbound-rtp" && r.kind === "audio");
  const transport = reports.find((r) => r.type === "transport" && r.selectedCandidatePairId);
  const pair = (transport && stats[transport.selectedCandidatePairId]) ||
    reports.find((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded");

  // The largest decoded inbound video is what the person is looking at.
  const mainInbound = inboundVideo
    .filter((r) => num(r.frameHeight))
    .sort((a, b) => (num(b.frameHeight) || 0) - (num(a.frameHeight) || 0))[0] || null;
  const activeOutbound = outboundVideo
    .filter((r) => num(r.frameHeight) && r.active !== false)
    .sort((a, b) => (num(b.frameHeight) || 0) - (num(a.frameHeight) || 0))[0] || null;

  const counters = {};
  let lost = 0;
  let received = 0;
  for (const r of [...inboundVideo, ...inboundAudio]) {
    const key = r.id;
    const pl = num(r.packetsLost) ?? 0;
    const pr = num(r.packetsReceived) ?? 0;
    counters[key] = { packetsLost: pl, packetsReceived: pr };
    const prev = previousCounters[key];
    if (prev && pr >= prev.packetsReceived) {
      lost += Math.max(0, pl - prev.packetsLost);
      received += pr - prev.packetsReceived;
    }
  }

  const localCandidate = pair ? stats[pair.localCandidateId] : null;
  return {
    sample: {
      recvHeight: mainInbound ? num(mainInbound.frameHeight) : null,
      recvFps: mainInbound ? num(mainInbound.framesPerSecond) : null,
      sendHeight: activeOutbound ? num(activeOutbound.frameHeight) : null,
      sendFps: activeOutbound ? num(activeOutbound.framesPerSecond) : null,
      limitation: activeOutbound?.qualityLimitationReason || null,
      rttMs: pair && num(pair.currentRoundTripTime) !== null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      outgoingKbps: pair && num(pair.availableOutgoingBitrate) !== null ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
      lossPct: received + lost > 0 ? Math.round((lost / (received + lost)) * 1000) / 10 : null,
      relay: localCandidate ? localCandidate.candidateType === "relay" : null,
    },
    counters,
  };
}

function median(values) {
  const list = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round(((list[mid - 1] + list[mid]) / 2) * 10) / 10;
}

function percentile(values, p) {
  const list = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor((p / 100) * list.length))];
}

function share(samples, predicate) {
  const relevant = samples.filter((s) => s !== null);
  if (!relevant.length) return null;
  return Math.round((relevant.filter(predicate).length / relevant.length) * 100);
}

/** Summary of one participant's call from its samples. */
export function summarizeSamples(samples) {
  const received = samples.filter((s) => s.recvHeight !== null);
  const sent = samples.filter((s) => s.sendHeight !== null);
  const limited = samples.filter((s) => s.limitation);
  return {
    samples: samples.length,
    recvHeightMedian: median(received.map((s) => s.recvHeight)),
    recvHdPct: share(received, (s) => s.recvHeight >= 720),
    recvLowPct: share(received, (s) => s.recvHeight < 360),
    recvFpsMedian: median(received.map((s) => s.recvFps)),
    sendHeightMedian: median(sent.map((s) => s.sendHeight)),
    sendFpsMedian: median(sent.map((s) => s.sendFps)),
    cpuLimitedPct: share(limited, (s) => s.limitation === "cpu"),
    bandwidthLimitedPct: share(limited, (s) => s.limitation === "bandwidth"),
    lossPctMedian: median(samples.map((s) => s.lossPct)),
    lossPctP95: percentile(samples.map((s) => s.lossPct), 95),
    rttMsMedian: median(samples.map((s) => s.rttMs)),
    rttMsP95: percentile(samples.map((s) => s.rttMs), 95),
    relayPct: share(samples.filter((s) => s.relay !== null), (s) => s.relay === true),
  };
}

/** Only identity fields useful for a quality report are kept. */
export function pickIdentity(data) {
  const d = data && typeof data === "object" ? data : {};
  const pick = (value, max = 160) => (typeof value === "string" ? value.slice(0, max) : undefined);
  return {
    confName: pick(d.confName),
    displayName: pick(d.displayName, 80),
    endpointId: pick(d.endpointId, 64),
    meetingUniqueId: pick(d.meetingUniqueId, 80),
    applicationName: pick(d.applicationName, 40),
    userAgent: pick(d.userAgent || d.browserName, 240),
  };
}
