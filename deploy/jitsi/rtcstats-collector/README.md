# Classroom video quality collector

Jitsi's embedded call cannot report media statistics to the classroom page,
so quality is measured on the video host instead. Every participant's browser
streams its WebRTC statistics (Jitsi's built-in rtcstats, protocol
`3.1_STANDARD`) to this small collector, which records one 10-second quality
sample per participant and writes a summary when they leave.

What is stored (in `/opt/speexify-rtcstats/data` on the video host):

- `summaries.jsonl`: one line per participant session. Fields: room,
  display name, Jitsi endpoint id, browser, minutes, P2P or bridge, median
  received and sent resolution and frame rate, share of time HD / low
  resolution, share of time limited by CPU or bandwidth, packet loss
  (median and p95), round-trip time (median and p95), and relay use.
- `samples/YYYY-MM-DD/<statsSessionId>.jsonl`: the 10-second samples behind
  each summary.

Raw getStats dumps, SDP and console logs are never stored. Only rooms whose
name starts with `speexify` are recorded. Writing stops if the folder
exceeds 2 GB.

## Reading the report

```sh
ssh speexify-video docker exec speexify-rtcstats node report.mjs            # last 7 days
ssh speexify-video docker exec speexify-rtcstats node report.mjs --days 30
ssh speexify-video docker exec speexify-rtcstats node report.mjs --json
```

A participant is flagged when, for example, more than 30% of the time they
received video below 360p, their camera encoder was CPU-limited or
bandwidth-limited more than 20% of the time, p95 packet loss was above 5%,
p95 delay was above 400 ms, or received video ran below 12 fps. Many
CPU-limited learners would justify moving VP9 ahead of AV1 in the codec
order (audit item M7).

Classroom room names are HMAC-derived (`speexify-<hash>`). To find the
lesson, compute `buildClassroomRoomName(sessionId)` in
`src/services/jitsiTokenService.js` for candidate session ids, or match on
display names and start times.

## Deployment (video host)

| Piece | Location |
| --- | --- |
| Collector source | this folder → `/opt/speexify-rtcstats/app` |
| Container | `speexify-rtcstats` (image `speexify-rtcstats:1`), on Docker network `jitsi_meet.jitsi`, 256 MB / 0.5 CPU, restart unless-stopped |
| Data | `/opt/speexify-rtcstats/data` (owned by uid 1000) |
| nginx route | `nginx-rtcstats.conf` → `/opt/jitsi/.jitsi-meet-cfg/web/nginx-custom/rtcstats.conf` (`wss://meet.speexify.com/rtcstats/`) |
| Jitsi setting | `custom-config.js` → `/opt/jitsi/.jitsi-meet-cfg/web/custom-config.js` (appended to `config.js` when the web container starts) |

Update the collector:

```sh
scp Dockerfile package.json package-lock.json stats.mjs server.mjs report.mjs speexify-video:/opt/speexify-rtcstats/app/
ssh speexify-video 'cd /opt/speexify-rtcstats/app && docker build -q -t speexify-rtcstats:1 . && docker rm -f speexify-rtcstats && docker run -d --name speexify-rtcstats --restart unless-stopped --network jitsi_meet.jitsi --memory 256m --cpus 0.5 --log-opt max-size=10m --log-opt max-file=3 -v /opt/speexify-rtcstats/data:/data speexify-rtcstats:1'
```

Turn statistics off: delete `custom-config.js` on the host and restart the
web container (`docker restart jitsi-web-1`) when no conference is live.
Calls work whether or not the collector is running.

Tests: `tests/unit/rtcstats-collector.test.js`.
