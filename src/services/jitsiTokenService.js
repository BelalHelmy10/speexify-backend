// src/services/jitsiTokenService.js
//
// Issues short-lived Jitsi JWTs (HS256, the format jitsi-meet's token auth
// expects) and derives an unguessable room name per classroom session.
// Without JITSI_APP_SECRET the service reports "not configured" and the
// legacy room name is used, so the frontend and Jitsi can be switched over
// independently.

import crypto from "node:crypto";
import {
  JITSI_APP_ID,
  JITSI_APP_SECRET,
  JITSI_DOMAIN,
  JITSI_TOKEN_TTL_SECONDS,
} from "../config/env.js";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function legacyClassroomRoomName(sessionId) {
  return `speexify-classroom-${sessionId}`;
}

export function buildClassroomRoomName(sessionId, { secret = JITSI_APP_SECRET } = {}) {
  if (!secret) return legacyClassroomRoomName(sessionId);
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`speexify-classroom-room:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `speexify-${digest}`;
}

export function signJitsiToken(
  { room, user, moderator },
  {
    secret = JITSI_APP_SECRET,
    appId = JITSI_APP_ID,
    domain = JITSI_DOMAIN,
    ttlSeconds = JITSI_TOKEN_TTL_SECONDS,
    now = Date.now(),
  } = {}
) {
  if (!secret) throw new Error("JITSI_APP_SECRET is not configured");
  if (!room) throw new Error("room is required");

  const issuedAt = Math.floor(now / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    aud: "jitsi",
    iss: appId,
    sub: domain,
    room,
    iat: issuedAt,
    nbf: issuedAt - 30,
    exp: issuedAt + ttlSeconds,
    moderator: Boolean(moderator),
    context: {
      user: {
        id: String(user.id),
        name: String(user.name || "Participant").slice(0, 120),
        moderator: Boolean(moderator),
        affiliation: moderator ? "owner" : "member",
      },
      features: {
        recording: false,
        livestreaming: false,
        transcription: false,
        "outbound-call": false,
      },
    },
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function isJitsiTokenAuthConfigured() {
  return Boolean(JITSI_APP_SECRET);
}

export function getJitsiDomain() {
  return JITSI_DOMAIN;
}
