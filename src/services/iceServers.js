// ICE servers for classroom screen sharing (browser to browser WebRTC).
import crypto from "node:crypto";
import {
  SCREEN_SHARE_STUN_URLS,
  TURN_CREDENTIAL,
  TURN_CREDENTIAL_TTL_SECONDS,
  TURN_SECRET,
  TURN_URLS,
  TURN_USERNAME,
} from "../config/env.js";

export function buildIceServers(
  userId,
  {
    stunUrls = SCREEN_SHARE_STUN_URLS,
    turnUrls = TURN_URLS,
    turnSecret = TURN_SECRET,
    turnUsername = TURN_USERNAME,
    turnCredential = TURN_CREDENTIAL,
    ttlSeconds = TURN_CREDENTIAL_TTL_SECONDS,
    now = Date.now(),
  } = {}
) {
  const servers = [];
  if (stunUrls.length) servers.push({ urls: stunUrls });

  if (turnUrls.length && turnSecret) {
    // coturn "REST API" credentials: valid until the expiry in the username.
    const expiresAt = Math.floor(now / 1000) + ttlSeconds;
    const username = `${expiresAt}:${userId}`;
    const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
    servers.push({ urls: turnUrls, username, credential });
  } else if (turnUrls.length && turnUsername && turnCredential) {
    servers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
  }

  return servers;
}
