// Speexify rtcstats collector.
//
// Receives Jitsi's rtcstats stream (protocol 3.1_STANDARD) from every
// participant's browser, keeps a 10-second quality sample per participant,
// and writes one summary line per participant when they leave:
//   /data/summaries.jsonl          one line per participant session
//   /data/samples/YYYY-MM-DD/<id>.jsonl   the 10 s samples behind it
//
// Raw stats, SDP and logs are never stored. Runs behind the Jitsi web
// container's nginx at wss://meet.speexify.com/rtcstats/.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocketServer } from "ws";
import { applyStatsDelta, pickIdentity, sampleFromStats, summarizeSamples } from "./stats.mjs";

const PORT = Number(process.env.PORT || 8099);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 300);
const MAX_MESSAGE_BYTES = 512 * 1024;
const SAMPLE_INTERVAL_MS = 10_000;
const MAX_SAMPLES_PER_SESSION = 2_000; // > 5 hours at one per 10 s
const MAX_DATA_BYTES = Number(process.env.MAX_DATA_BYTES || 2 * 1024 ** 3);
const PROTOCOL = "3.1_STANDARD";

fs.mkdirSync(path.join(DATA_DIR, "samples"), { recursive: true });

// statsSessionId -> { lastSeq, identity, meeting, startedAt, pcs: Map, samples: [] }
const sessions = new Map();

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

let dataBytes = 0;
function refreshDataSize() {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  try { walk(DATA_DIR); } catch { /* ignore */ }
  dataBytes = total;
}
refreshDataSize();
setInterval(refreshDataSize, 10 * 60 * 1000).unref();

function append(file, line) {
  if (dataBytes > MAX_DATA_BYTES) return; // disk guard
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
  dataBytes += line.length + 1;
}

function getSession(id, meeting) {
  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      meeting,
      lastSeq: 0,
      identity: {},
      startedAt: Date.now(),
      lastSampleAt: 0,
      pcs: new Map(),
      samples: [],
      connections: 0,
      flushed: false,
    };
    sessions.set(id, session);
  }
  return session;
}

function recordSample(session) {
  const now = Date.now();
  if (now - session.lastSampleAt < SAMPLE_INTERVAL_MS - 500) return;
  session.lastSampleAt = now;
  // Prefer the peer connection that is actually carrying media (P2P or JVB).
  let best = null;
  for (const [pcId, pc] of session.pcs) {
    const { sample, counters } = sampleFromStats(pc.stats, pc.counters);
    pc.counters = counters;
    const score = (sample.recvHeight || 0) + (sample.sendHeight || 0);
    if (!best || score > best.score) best = { pcId, p2p: pc.p2p, sample, score };
  }
  if (!best || best.score === 0 && best.sample.rttMs === null) return;
  const entry = { t: now, pc: best.p2p ? "p2p" : "jvb", ...best.sample };
  if (session.samples.length < MAX_SAMPLES_PER_SESSION) session.samples.push(entry);
  if (!/^speexify/i.test(String(session.meeting || "").split("@")[0])) return;
  const day = new Date(session.startedAt).toISOString().slice(0, 10);
  append(path.join(DATA_DIR, "samples", day, `${session.id}.jsonl`), JSON.stringify(entry));
}

function flushSession(session, reason) {
  if (session.flushed) return;
  session.flushed = true;
  sessions.delete(session.id);
  if (!session.samples.length) return;
  // Only Speexify classroom rooms are recorded.
  if (!/^speexify/i.test(String(session.meeting || "").split("@")[0])) return;
  const summary = {
    statsSessionId: session.id,
    meeting: session.meeting,
    ...pickIdentity(session.identity),
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    minutes: Math.round((Date.now() - session.startedAt) / 6000) / 10,
    p2pPct: Math.round((session.samples.filter((s) => s.pc === "p2p").length / session.samples.length) * 100),
    ...summarizeSamples(session.samples),
    reason,
  };
  append(path.join(DATA_DIR, "summaries.jsonl"), JSON.stringify(summary));
  log("session_summary", { id: session.id, meeting: session.meeting, samples: session.samples.length });
}

function handleStatsEntry(session, entry) {
  if (!Array.isArray(entry)) return;
  const [method, pcId, payload, , seq] = entry;
  if (Number.isFinite(seq)) session.lastSeq = Math.max(session.lastSeq, seq);
  if (!pcId) return;
  let pc = session.pcs.get(pcId);
  if (!pc) {
    pc = { stats: {}, counters: {}, p2p: false };
    session.pcs.set(pcId, pc);
  }
  // lib-jitsi-meet marks its peer-to-peer connection in the constraints it
  // passes to RTCPeerConnection: { optional: [{ rtcStatsSFUP2P: true }] }.
  if (method === "constraints" && Array.isArray(payload?.optional)) {
    pc.p2p = payload.optional.some((option) => option?.rtcStatsSFUP2P === true);
  }
  if (method === "getstats" || method === "getStats") {
    pc.stats = applyStatsDelta(pc.stats, payload);
    recordSample(session);
  }
  if (method === "close") {
    session.pcs.delete(pcId);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, dataBytes }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_BYTES,
  handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
});

wss.on("connection", (ws, req) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    ws.close(1013, "busy");
    return;
  }
  const url = new URL(req.url, "http://collector");
  const id = (url.searchParams.get("statsSessionId") || "").slice(0, 64);
  // Path is /<meetingFqn> (nginx strips /rtcstats). Jitsi opens the trace
  // before joining, so it is often empty; the room then comes from the
  // identity message (confName).
  let meeting = "";
  try {
    meeting = decodeURIComponent(url.pathname.replace(/^\/+/, "")).slice(0, 200);
  } catch {
    meeting = "";
  }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    ws.close(1008, "unsupported");
    return;
  }

  const session = getSession(id, meeting);
  if (meeting && !session.meeting) session.meeting = meeting;
  session.connections += 1;
  // The client only starts sending after this acknowledgement; on reconnect
  // it replays everything after `value`.
  ws.send(JSON.stringify({ type: "sn", body: { value: session.lastSeq, state: "initial" } }));

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type === "identity" && Array.isArray(message.data)) {
      session.identity = { ...session.identity, ...(message.data[2] || {}) };
      if (!session.meeting && typeof session.identity.confName === "string") {
        session.meeting = session.identity.confName.slice(0, 200);
      }
      if (Number.isFinite(message.data[4])) session.lastSeq = Math.max(session.lastSeq, message.data[4]);
      return;
    }
    if (message?.type === "stats-entry" && typeof message.data === "string") {
      try {
        handleStatsEntry(session, JSON.parse(message.data));
      } catch (err) {
        log("bad_entry", { id, error: err.message });
      }
    }
  });

  ws.on("close", (code) => {
    session.connections -= 1;
    // 3001 = the page closed the trace on purpose (call ended). Otherwise
    // wait for a reconnect before summarising.
    const delay = code === 3001 ? 0 : 120_000;
    setTimeout(() => {
      if (session.connections <= 0) flushSession(session, code === 3001 ? "ended" : `closed_${code}`);
    }, delay).unref();
  });
});

function shutdown() {
  for (const session of [...sessions.values()]) flushSession(session, "collector_stopped");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => log("listening", { port: PORT, dataDir: DATA_DIR }));
