// src/webrtcSignaling/token.js

import crypto from "node:crypto";
import { WS_AUTH_TOKEN_SECRET } from "../config/env.js";

const DEFAULT_WS_AUTH_TTL_MS = (() => {
  const raw = Number(process.env.WS_AUTH_TOKEN_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 5 * 60 * 1000; // 5 minutes
  return Math.floor(raw);
})();

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input) {
  const normalized = String(input)
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(input).length / 4) * 4, "=");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function signPayload(encodedPayload) {
  return base64urlEncode(
    crypto
      .createHmac("sha256", WS_AUTH_TOKEN_SECRET)
      .update(encodedPayload)
      .digest()
  );
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function getWsAuthTokenTtlMs() {
  return DEFAULT_WS_AUTH_TTL_MS;
}

export function createWsAuthToken({ userId, ttlMs = DEFAULT_WS_AUTH_TTL_MS }) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("createWsAuthToken: userId is required");
  }

  const now = Date.now();
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Math.floor(Number(ttlMs))
    : DEFAULT_WS_AUTH_TTL_MS;
  const expiresAt = now + ttl;

  const payload = {
    v: 1,
    u: normalizedUserId,
    iat: now,
    exp: expiresAt,
    n: crypto.randomBytes(8).toString("hex"),
  };

  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt,
  };
}

export function verifyWsAuthToken(token, { now = Date.now() } = {}) {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "Missing token" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Malformed token" };
  }

  const [encodedPayload, signature] = parts;
  const expectedSignature = signPayload(encodedPayload);
  if (!timingSafeEqualString(signature, expectedSignature)) {
    return { valid: false, reason: "Invalid token signature" };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch {
    return { valid: false, reason: "Invalid token payload" };
  }

  if (!payload || payload.v !== 1) {
    return { valid: false, reason: "Unsupported token version" };
  }

  const userId = String(payload.u || "").trim();
  if (!userId) {
    return { valid: false, reason: "Token missing user id" };
  }

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { valid: false, reason: "Token missing expiry" };
  }

  if (now > exp) {
    return { valid: false, reason: "Token expired" };
  }

  return { valid: true, userId, payload };
}
