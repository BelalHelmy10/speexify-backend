// Per-lesson video quality report from the collector's summaries.
//
//   docker exec speexify-rtcstats node report.mjs            # last 7 days
//   docker exec speexify-rtcstats node report.mjs --days 30
//   docker exec speexify-rtcstats node report.mjs --json     # machine-readable
//
// A participant is flagged when their call had a problem worth looking at.

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1]) || 7;
const asJson = args.includes("--json");
const since = Date.now() - days * 24 * 60 * 60 * 1000;

const file = path.join(DATA_DIR, "summaries.jsonl");
const rows = fs.existsSync(file)
  ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((row) => row && Date.parse(row.startedAt) >= since)
  : [];

function problemsFor(row) {
  const problems = [];
  if (row.recvLowPct !== null && row.recvLowPct > 30) problems.push(`low-res received ${row.recvLowPct}%`);
  if (row.cpuLimitedPct !== null && row.cpuLimitedPct > 20) problems.push(`CPU-limited ${row.cpuLimitedPct}%`);
  if (row.bandwidthLimitedPct !== null && row.bandwidthLimitedPct > 20) problems.push(`bandwidth-limited ${row.bandwidthLimitedPct}%`);
  if (row.lossPctP95 !== null && row.lossPctP95 > 5) problems.push(`packet loss p95 ${row.lossPctP95}%`);
  if (row.rttMsP95 !== null && row.rttMsP95 > 400) problems.push(`delay p95 ${row.rttMsP95}ms`);
  if (row.recvFpsMedian !== null && row.recvFpsMedian < 12) problems.push(`choppy ${row.recvFpsMedian} fps`);
  return problems;
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(rows.map((row) => ({ ...row, problems: problemsFor(row) })), null, 1)}\n`);
} else {
  const byMeeting = new Map();
  for (const row of rows) {
    const key = row.meeting || row.confName || "unknown";
    if (!byMeeting.has(key)) byMeeting.set(key, []);
    byMeeting.get(key).push(row);
  }
  const flagged = rows.filter((row) => problemsFor(row).length).length;
  console.log(`Classroom video quality, last ${days} day(s): ${byMeeting.size} call(s), ${rows.length} participant session(s), ${flagged} flagged\n`);
  for (const [meeting, participants] of [...byMeeting].sort((a, b) => Date.parse(b[1][0].startedAt) - Date.parse(a[1][0].startedAt))) {
    console.log(`${participants[0].startedAt.slice(0, 16).replace("T", " ")} UTC  ${meeting.split("@")[0]}`);
    for (const row of participants) {
      const problems = problemsFor(row);
      console.log(
        `  ${(row.displayName || row.endpointId || "?").padEnd(24).slice(0, 24)} ${String(row.minutes).padStart(5)} min  ` +
        `recv ${row.recvHeightMedian ?? "-"}p@${row.recvFpsMedian ?? "-"}fps  send ${row.sendHeightMedian ?? "-"}p  ` +
        `rtt ${row.rttMsMedian ?? "-"}ms  loss ${row.lossPctMedian ?? "-"}%  ${row.p2pPct >= 50 ? "p2p" : "bridge"}` +
        `${problems.length ? `  ⚠ ${problems.join(", ")}` : ""}`
      );
    }
  }
}
