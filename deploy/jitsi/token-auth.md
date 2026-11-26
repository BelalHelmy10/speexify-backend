# Classroom video token authentication

Since 26 November 2026, `meet.speexify.com` only admits participants with a
token signed by the Speexify backend, and only the session teacher (or an
admin) becomes a Jitsi moderator.

## Why

Before this change the video server accepted anyone, and room names were
`speexify-classroom-<sessionId>`. Anyone who guessed a session id could join
a lesson, and the first person to join became moderator (in testing, a
learner who joined first could mute or remove the teacher).

## How it works

- **Backend (Render):** `JITSI_APP_SECRET` is set. `GET /sessions/:id/video-access`
  returns an HMAC-derived, unguessable room name and an HS256 token
  (`aud: jitsi`, `iss: speexify`, `room: <name>`,
  `context.user.moderator: true` only for the teacher/admin). See
  `src/services/jitsiTokenService.js`.
- **Video host `/opt/jitsi/.env`** (values other than the secret):

  | Variable | Value | Purpose |
  | --- | --- | --- |
  | `ENABLE_AUTH` | `1` | Require authentication |
  | `AUTH_TYPE` | `jwt` | Token authentication |
  | `JWT_APP_ID` | `speexify` | Must equal the token issuer |
  | `JWT_APP_SECRET` | same value as Render's `JITSI_APP_SECRET` | Shared HS256 secret |
  | `ENABLE_GUESTS` | `0` | No anonymous guest domain |
  | `JICOFO_ENABLE_AUTH` | `0` | Jicofo would otherwise make every authenticated user a moderator |
  | `ENABLE_AUTO_OWNER` | `0` | The first joiner is not made moderator |
  | `XMPP_MUC_MODULES` | `speexify_token_moderator` | Grants moderator only from the token claim |

- **Prosody plugin:**
  `/opt/jitsi/.jitsi-meet-cfg/prosody/prosody-plugins-custom/mod_speexify_token_moderator.lua`
  sets the MUC owner affiliation when `context.user.moderator` is true.

The shared secret is stored only in Render, in `/opt/jitsi/.env` (mode 600)
and in `/root/.jitsi_jwt_secret` (mode 600) on the video host. Never commit,
print or paste it into tickets.

## Changing settings

Scripts on the video host:

- `/root/c2-apply.sh` applies the settings above. It refuses to run while a
  conference is live (`FORCE=1` overrides) and recreates only prosody,
  jicofo and web, without pulling images (they run the `unstable` tag).
- `/root/c2-rollback.sh` restores the pre-change `.env` from
  `/opt/jitsi/c2-backup-20261126-1753/` and recreates the same containers.

Rotating the secret: set the new value on Render **and** in
`/root/.jitsi_jwt_secret`, then run `c2-apply.sh` immediately after the Render
deploy goes live (calls fail while the two values differ).

## Verification (26 November 2026)

- A caller without a token was refused.
- A learner token joining first stayed a participant; the teacher token became
  moderator.
- `node scripts/diagnoseLiveClassroom.mjs bridge|relay|p2p` and the TLS-only
  relay probe all passed with tokens (frontend repo; the script signs test
  tokens from `~/.speexify/jitsi_jwt_secret`).
