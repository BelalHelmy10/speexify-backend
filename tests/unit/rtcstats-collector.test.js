import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStatsDelta,
  pickIdentity,
  sampleFromStats,
  summarizeSamples,
} from "../../deploy/jitsi/rtcstats-collector/stats.mjs";

test("delta-compressed getstats payloads rebuild the full stats", () => {
  // First poll: full reports, newest timestamp replaced by 0.
  let stats = applyStatsDelta({}, {
    IT01V: { type: "inbound-rtp", kind: "video", frameHeight: 180, framesPerSecond: 20, packetsReceived: 100, packetsLost: 0, timestamp: 0 },
    timestamp: 1000,
  });
  assert.equal(stats.IT01V.frameHeight, 180);
  assert.equal(stats.IT01V.timestamp, 1000);
  // Second poll: only changed fields.
  stats = applyStatsDelta(stats, { IT01V: { frameHeight: 720, packetsReceived: 200, timestamp: 0 }, timestamp: 11000 });
  assert.deepEqual(
    [stats.IT01V.frameHeight, stats.IT01V.framesPerSecond, stats.IT01V.packetsReceived, stats.IT01V.timestamp],
    [720, 20, 200, 11000]
  );
  assert.deepEqual(applyStatsDelta(stats, null), stats);
});

test("a sample reports what was seen, sent, limited and lost", () => {
  const stats = {
    T01: { id: "T01", type: "transport", selectedCandidatePairId: "CP1" },
    CP1: { id: "CP1", type: "candidate-pair", currentRoundTripTime: 0.082, availableOutgoingBitrate: 2_400_000, localCandidateId: "L1", state: "succeeded" },
    L1: { id: "L1", type: "local-candidate", candidateType: "relay" },
    IV1: { id: "IV1", type: "inbound-rtp", kind: "video", frameHeight: 720, framesPerSecond: 24, packetsReceived: 1100, packetsLost: 12 },
    IV2: { id: "IV2", type: "inbound-rtp", kind: "video", frameHeight: 180, framesPerSecond: 15, packetsReceived: 500, packetsLost: 0 },
    OV1: { id: "OV1", type: "outbound-rtp", kind: "video", frameHeight: 360, framesPerSecond: 15, qualityLimitationReason: "cpu" },
  };
  const first = sampleFromStats(stats);
  assert.equal(first.sample.lossPct, null); // no previous counters yet
  const { sample } = sampleFromStats(
    { ...stats, IV1: { ...stats.IV1, packetsReceived: 1190, packetsLost: 22 } },
    first.counters
  );
  assert.deepEqual(sample, {
    recvHeight: 720,
    recvFps: 24,
    sendHeight: 360,
    sendFps: 15,
    limitation: "cpu",
    rttMs: 82,
    outgoingKbps: 2400,
    lossPct: 10,
    relay: true,
  });
});

test("summaries show how often video was HD, low, or CPU/bandwidth limited", () => {
  const samples = [
    { recvHeight: 720, recvFps: 25, sendHeight: 720, sendFps: 25, limitation: "none", lossPct: 0, rttMs: 60, relay: false },
    { recvHeight: 720, recvFps: 24, sendHeight: 360, sendFps: 15, limitation: "cpu", lossPct: 1, rttMs: 70, relay: false },
    { recvHeight: 180, recvFps: 10, sendHeight: 180, sendFps: 10, limitation: "bandwidth", lossPct: 6, rttMs: 300, relay: false },
    { recvHeight: null, recvFps: null, sendHeight: null, sendFps: null, limitation: null, lossPct: null, rttMs: null, relay: null },
  ];
  const summary = summarizeSamples(samples);
  assert.equal(summary.samples, 4);
  assert.equal(summary.recvHdPct, 67);
  assert.equal(summary.recvLowPct, 33);
  assert.equal(summary.recvHeightMedian, 720);
  assert.equal(summary.cpuLimitedPct, 33);
  assert.equal(summary.bandwidthLimitedPct, 33);
  assert.equal(summary.rttMsP95, 300);
  assert.equal(summary.relayPct, 0);
});

test("only a few identity fields are kept, and they are bounded", () => {
  const picked = pickIdentity({ confName: "speexify-abc@conference.meet", displayName: "x".repeat(200), password: "no", endpointId: "e1" });
  assert.equal(picked.displayName.length, 80);
  assert.equal(picked.password, undefined);
  assert.equal(picked.endpointId, "e1");
  assert.deepEqual(Object.keys(pickIdentity(null)), ["confName", "displayName", "endpointId", "meetingUniqueId", "applicationName", "userAgent"]);
});
