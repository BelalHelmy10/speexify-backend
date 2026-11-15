# Classroom video relay

Speexify's classroom membership/signaling and Jitsi media connections are
separate. Room admission does not prove two-way audio/video connectivity.
Jitsi clients need an authenticated TURN fallback when their networks cannot
establish a direct connection.

## Production repair, 15 November 2026

The existing Jitsi host had no coturn service or advertised TURN credentials.
Two synthetic callers could enter the room while receiving no remote media
when configured to require a relay. Direct calls worked in the control test.
The original customer's exact failure could not be conclusively attributed
from the available logs.

With owner approval, the existing Ubuntu host was repaired during a verified
idle window:

- Installed Ubuntu's coturn package and enabled it after authenticated settings
  were ready. TURN listens on UDP/TCP 3478; TURN over TLS listens on TCP 5349.
  Relay allocations use UDP ports 49160–49260.
- Configured shared-secret authentication, short-lived credentials, allocation
  quotas, and restrictions on private, link-local, loopback and multicast peers.
- Configured Prosody's `external_services` discovery through the existing
  deployment's environment settings. The same secret is held only in protected
  server files, not in this repository or frontend assets.
- Reused the valid `meet.speexify.com` certificate, with restricted copies for
  coturn and an hourly certificate-sync timer.
- Recreated only Prosody with its already installed image and pulling disabled.
  Its image SHA was unchanged; web, JVB and Jicofo were not restarted.

No Speexify API or database migration is required for this repair. The Jitsi
Compose deployment is maintained on the video host, separately from this API.

## Configuration locations

| Purpose | Location on the video host |
| --- | --- |
| Jitsi deployment | `/opt/jitsi` |
| Service discovery settings | `/opt/jitsi/.env` |
| Relay configuration | `/etc/turnserver.conf` |
| Protected relay certificate copies | `/etc/coturn-certs` |
| Existing Jitsi certificate | `/opt/jitsi/.jitsi-meet-cfg/web/acme-certs/meet.speexify.com/` |
| Certificate-sync helper | `/usr/local/sbin/speexify-relay-cert-sync` |
| Certificate-sync timer | `speexify-relay-cert-sync.timer` |
| Pre-repair configuration backup | `/opt/jitsi/relay-backup-20261115/` |

The configured discovery variables are `TURN_HOST`, `TURNS_HOST`, `TURN_PORT`,
`TURNS_PORT`, `TURN_TRANSPORT`, `TURN_TTL` and `TURN_CREDENTIALS`. Use the
deployment's actual Prosody templates when changing these: names and behavior
can differ between Jitsi versions. Never print or commit credential values.

The relay config and private-key copy are owned by root with group `turnserver`
and mode `0640`. The sync helper refreshes certificate copies after Jitsi
renewal and restarts coturn only when the files change. Check that both coturn
and its certificate timer remain enabled after host maintenance.

## Verification

The frontend repository provides `scripts/diagnoseLiveClassroom.mjs`. It uses
isolated rooms with two synthetic callers and fake cameras/microphones; it does
not enter customer sessions. Run from that repository:

```sh
node scripts/diagnoseLiveClassroom.mjs bridge
node scripts/diagnoseLiveClassroom.mjs relay
DIAGNOSTIC_TURN_TLS_ONLY=1 node scripts/diagnoseLiveClassroom.mjs relay
```

All three probes passed after the repair: each caller received actual audio
and decoded remote video, and both relay probes selected relay candidates.
The TLS-only probe confirmed TLS relay transport. Tests also verified trusted
certificate validation, coturn active/enabled, the certificate timer active,
and all four Jitsi containers running.

Require these media checks after future video-server/network changes. A green
layout test, an existing iframe, or a room-joined event is not equivalent to
received media. Physical iPhone/iPad, Android and desktop coverage is a separate
release requirement; the server probes do not certify every device.

**Remaining network limitation:** TURN/TLS on TCP 443 is not configured. Jitsi
web already owns that port. Networks permitting only TCP 443 require a tested
routing/DNS/certificate plan before claiming support. Do not move the existing
web listener without preserving a rollback path and checking for active calls.

## Rollback

Perform disruptive changes only during a verified no-call window. Back up the
current configuration before restoring an older snapshot. The pre-repair backup
contains the original `.env`, compose file, coturn config and Prosody image SHA.

To undo this repair, stop and disable coturn and the certificate-sync timer,
restore the backed-up Jitsi `.env`, then recreate only Prosody from the existing
image:

```sh
cd /opt/jitsi
docker compose up -d --no-deps --pull never prosody
```

Verify room admission and two-way media after rollback. Keep private keys and
shared secrets on the host; redact them from logs, tickets and screenshots.
