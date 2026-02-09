// src/webrtcSignaling/auth.js

import { parse as parseCookieHeader } from "cookie";
import { unsign as unsignCookieValue } from "cookie-signature";
import { logger } from "../lib/logger.js";
import { SESSION_SECRET } from "../config/env.js";
import { SESSION_COOKIE_NAME } from "../config/session.js";
import { sessionMiddleware } from "../middleware/session.js";
import { CONFIG } from "./config.js";

function extractTokenFromRequest(request) {
  const protocols = request.headers[CONFIG.AUTH_TOKEN_HEADER];
  if (typeof protocols === "string" && protocols.trim()) {
    const protocolList = protocols.split(",").map((p) => p.trim());
    const candidate = protocolList.find((p) => p && p !== "websocket");
    if (candidate) return candidate;
  }

  try {
    const url = new URL(request.url || "", "http://localhost");
    const token = url.searchParams.get("token");
    if (token) return token;
  } catch {
    // Ignore URL parsing errors
  }

  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

function getSessionIdFromRequest(request) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return null;

  let cookies;
  try {
    cookies = parseCookieHeader(cookieHeader);
  } catch {
    return null;
  }

  const rawCookie = cookies?.[SESSION_COOKIE_NAME];
  if (!rawCookie) return null;

  let decoded = rawCookie;
  try {
    decoded = decodeURIComponent(rawCookie);
  } catch {
    // Keep raw value when decoding fails.
  }

  if (!decoded.startsWith("s:")) {
    return decoded || null;
  }

  if (!SESSION_SECRET) return null;

  const unsigned = unsignCookieValue(decoded.slice(2), SESSION_SECRET);
  if (!unsigned) return null;
  return unsigned;
}

async function getSessionById(sessionId) {
  if (!sessionId) return null;
  const store = sessionMiddleware?.store;
  if (!store || typeof store.get !== "function") return null;

  return await new Promise((resolve) => {
    store.get(sessionId, (err, sessionData) => {
      if (err) {
        logger.warn({ err }, "[Auth] Failed to load session for WebSocket");
        return resolve(null);
      }
      return resolve(sessionData || null);
    });
  });
}

async function authenticateFromSession(request) {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return null;

  const sessionData = await getSessionById(sessionId);
  const sessionUser = sessionData?.user;
  if (!sessionUser?.id) return null;

  return {
    authenticated: true,
    userId: String(sessionUser.id),
    authSource: "session",
  };
}

async function authenticateConnection(request) {
  if (!CONFIG.AUTH_ENABLED) {
    return { authenticated: true, userId: "anonymous", authSource: "disabled" };
  }

  try {
    const sessionAuth = await authenticateFromSession(request);
    if (sessionAuth) return sessionAuth;

    const token = extractTokenFromRequest(request);

    if (!token) {
      return {
        authenticated: false,
        reason: "No valid session or token provided",
      };
    }

    const result = await CONFIG.validateToken(token, request);
    if (result.valid) {
      return {
        authenticated: true,
        userId: String(result.userId),
        authSource: "token",
      };
    }

    return { authenticated: false, reason: result.reason || "Invalid token" };
  } catch (err) {
    logger.error({ err }, "[Auth] Authentication error");
    return { authenticated: false, reason: "Authentication error" };
  }
}

export { authenticateConnection };
