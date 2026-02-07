// src/webrtcSignaling/config.js
import { ALLOWED_ORIGINS as HTTP_ALLOWED_ORIGINS, isProd } from "../config/env.js";

function parseBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;

  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/, "");
}

function parseOriginsEnv(raw) {
  if (!raw || typeof raw !== "string") return null;
  const list = raw
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
  return list.length ? list : null;
}

const wsAllowedOrigins =
  parseOriginsEnv(process.env.WS_ALLOWED_ORIGINS) ||
  HTTP_ALLOWED_ORIGINS.map((origin) => normalizeOrigin(origin)).filter(Boolean);

const CONFIG = {
  AUTH_ENABLED: parseBooleanEnv("WS_AUTH_ENABLED", true),
  AUTH_TOKEN_HEADER: "sec-websocket-protocol",
  validateToken: async (token, request) => {
    return {
      valid: false,
      reason: "Token auth is not configured for this environment",
    };
  },

  ALLOWED_ORIGINS: wsAllowedOrigins,

  RATE_LIMIT_ENABLED: true,
  RATE_LIMIT_WINDOW_MS: 1000,
  RATE_LIMIT_MAX_MESSAGES: 200,

  MAX_CONNECTIONS_TOTAL: 10000,
  MAX_CONNECTIONS_PER_IP: 50,

  MAX_TOTAL_ROOMS: 5000,
  MAX_VIDEO_PEERS: 2,
  MAX_CLASSROOM_PEERS: 100,

  MAX_MESSAGE_SIZE_BYTES: 1048576,

  ROOM_ID_REGEX: /^[a-zA-Z0-9_-]{1,128}$/,

  HEARTBEAT_ENABLED: true,
  HEARTBEAT_INTERVAL_MS: 30000,
  HEARTBEAT_TIMEOUT_MS: 10000,

  VALID_SIGNAL_TYPES: null,

  MAX_SIGNAL_DATA_SIZE: 262144,
};

const MSG_TYPES = {
  JOIN: "join",
  LEAVE: "leave",
  SIGNAL: "signal",
  JOINED: "joined",
  ROOM_FULL: "room-full",
  PEER_JOINED: "peer-joined",
  PEER_LEFT: "peer-left",
  ERROR: "error",
  PONG: "pong",
};

function validateOrigin(request) {
  if (!CONFIG.ALLOWED_ORIGINS || CONFIG.ALLOWED_ORIGINS.length === 0) {
    return !isProd;
  }

  const origin = normalizeOrigin(request.headers.origin);
  if (!origin) {
    return !isProd;
  }

  return CONFIG.ALLOWED_ORIGINS.includes(origin);
}

export { CONFIG, MSG_TYPES, normalizeOrigin, validateOrigin };
