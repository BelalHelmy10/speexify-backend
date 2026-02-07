// src/webrtcSignaling.js
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookieHeader } from "cookie";
import { unsign as unsignCookieValue } from "cookie-signature";
import { logger } from "./lib/logger.js";
import {
  ALLOWED_ORIGINS as HTTP_ALLOWED_ORIGINS,
  SESSION_SECRET,
  isProd,
} from "./config/env.js";
import { SESSION_COOKIE_NAME } from "./config/session.js";
import { sessionMiddleware } from "./middleware/session.js";

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

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION - All security settings in one place
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // Authentication (override with WS_AUTH_ENABLED=false for local debugging only)
  AUTH_ENABLED: parseBooleanEnv("WS_AUTH_ENABLED", true),
  AUTH_TOKEN_HEADER: "sec-websocket-protocol", // or use a custom header
  validateToken: async (token, request) => {
    // Override this function to implement your auth logic
    // Return { valid: true, userId: "..." } or { valid: false }
    // Example: return await verifyJWT(token);
    return {
      valid: false,
      reason: "Token auth is not configured for this environment",
    };
  },

  // Origin validation (override with WS_ALLOWED_ORIGINS)
  ALLOWED_ORIGINS: wsAllowedOrigins, // e.g., ["https://yourapp.com", "https://www.yourapp.com"]

  // Rate limiting
  RATE_LIMIT_ENABLED: true,
  RATE_LIMIT_WINDOW_MS: 1000, // 1 second window
  RATE_LIMIT_MAX_MESSAGES: 200, // allow drag/resize streams

  // Connection limits
  MAX_CONNECTIONS_TOTAL: 10000,
  MAX_CONNECTIONS_PER_IP: 50,

  // Room limits
  MAX_TOTAL_ROOMS: 5000,
  MAX_VIDEO_PEERS: 2,
  MAX_CLASSROOM_PEERS: 100,

  // Message limits
  MAX_MESSAGE_SIZE_BYTES: 1048576, // 1MB for classroom annotations

  // Room ID validation
  ROOM_ID_REGEX: /^[a-zA-Z0-9_-]{1,128}$/,

  // Heartbeat (ping/pong)
  HEARTBEAT_ENABLED: true,
  HEARTBEAT_INTERVAL_MS: 30000, // 30 seconds
  HEARTBEAT_TIMEOUT_MS: 10000, // 10 seconds to respond

  // Valid signal types for WebRTC
  // NOTE: set to null or [] to allow ANY signalType (matches the original behavior).
  VALID_SIGNAL_TYPES: null,
  // e.g. to be strict later:
  // VALID_SIGNAL_TYPES: ["offer", "answer", "candidate", "renegotiate"],

  // Max size for signal data payload (after JSON.stringify if needed)
  // Increased to 256KB to play nicer with classroom/materials payloads.
  MAX_SIGNAL_DATA_SIZE: 262144, // 256KB
};

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE TYPES - Constants to avoid magic strings
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
const socketMeta = new WeakMap();

function getMeta(ws) {
  let meta = socketMeta.get(ws);
  if (!meta) {
    meta = {
      videoRoomId: null,
      classroomRoomId: null,
      isInitiator: false,
      userId: null,
      ip: null,
      isAlive: true,
      messageTimestamps: [],
    };
    socketMeta.set(ws, meta);
  }
  return meta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION TRACKING - For connection limits
// ═══════════════════════════════════════════════════════════════════════════════
const connectionsByIP = new Map(); // IP -> Set<WebSocket>
let totalConnections = 0;

function trackConnection(ws, ip) {
  totalConnections++;

  let ipConnections = connectionsByIP.get(ip);
  if (!ipConnections) {
    ipConnections = new Set();
    connectionsByIP.set(ip, ipConnections);
  }
  ipConnections.add(ws);

  getMeta(ws).ip = ip;
}

function untrackConnection(ws) {
  totalConnections = Math.max(0, totalConnections - 1);

  const meta = getMeta(ws);
  if (meta.ip) {
    const ipConnections = connectionsByIP.get(meta.ip);
    if (ipConnections) {
      ipConnections.delete(ws);
      if (ipConnections.size === 0) {
        connectionsByIP.delete(meta.ip);
      }
    }
  }
}

function canAcceptConnection(ip) {
  if (totalConnections >= CONFIG.MAX_CONNECTIONS_TOTAL) {
    return { allowed: false, reason: "Server at maximum capacity" };
  }

  const ipConnections = connectionsByIP.get(ip);
  if (ipConnections && ipConnections.size >= CONFIG.MAX_CONNECTIONS_PER_IP) {
    return { allowed: false, reason: "Too many connections from your IP" };
  }

  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════
function checkRateLimit(ws) {
  if (!CONFIG.RATE_LIMIT_ENABLED) return true;

  const meta = getMeta(ws);
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;

  // Remove timestamps outside the window
  meta.messageTimestamps = meta.messageTimestamps.filter(
    (t) => t > windowStart
  );

  if (meta.messageTimestamps.length >= CONFIG.RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }

  meta.messageTimestamps.push(now);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function validateRoomId(roomId) {
  if (!roomId || typeof roomId !== "string") {
    return { valid: false, reason: "Invalid roomId" };
  }
  if (!CONFIG.ROOM_ID_REGEX.test(roomId)) {
    return {
      valid: false,
      reason: "RoomId contains invalid characters or is too long",
    };
  }
  return { valid: true };
}

function validateSignalPayload(msg) {
  // NOTE: We keep this deliberately close to the old behavior.
  // Only enforce `data` presence + size by default.
  // Type filtering is optional via CONFIG.VALID_SIGNAL_TYPES.

  // Optional signalType filtering
  if (
    CONFIG.VALID_SIGNAL_TYPES &&
    Array.isArray(CONFIG.VALID_SIGNAL_TYPES) &&
    CONFIG.VALID_SIGNAL_TYPES.length > 0
  ) {
    if (
      !msg.signalType ||
      !CONFIG.VALID_SIGNAL_TYPES.includes(msg.signalType)
    ) {
      return { valid: false, reason: "Invalid signal type" };
    }
  }

  // Data existence (many app-level signals rely on this)
  if (msg.data === undefined || msg.data === null) {
    return { valid: false, reason: "Missing signal data" };
  }

  // Check data size (stringify to check actual size)
  try {
    const dataStr =
      typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
    if (
      typeof CONFIG.MAX_SIGNAL_DATA_SIZE === "number" &&
      dataStr.length > CONFIG.MAX_SIGNAL_DATA_SIZE
    ) {
      return { valid: false, reason: "Signal data too large" };
    }
  } catch {
    return { valid: false, reason: "Invalid signal data format" };
  }

  return { valid: true };
}

function validateOrigin(request) {
  if (!CONFIG.ALLOWED_ORIGINS || CONFIG.ALLOWED_ORIGINS.length === 0) {
    return !isProd; // In production, explicit allowlist is required.
  }

  const origin = normalizeOrigin(request.headers.origin);
  if (!origin) {
    return !isProd;
  }

  return CONFIG.ALLOWED_ORIGINS.includes(origin);
}

function getClientIP(request) {
  // Handle proxies (Render, Cloudflare, etc.)
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    return ips[0]; // First IP is the original client
  }
  return request.socket?.remoteAddress || "unknown";
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM MANAGER FACTORY - DRY principle, shared logic for video and classroom
// ═══════════════════════════════════════════════════════════════════════════════
function createRoomManager(options) {
  const {
    name,
    maxPeers,
    maxRooms,
    roomIdKey, // 'videoRoomId' or 'classroomRoomId'
    notifyOnJoin = true,
    notifyOnLeave = true,
    trackInitiator = false,
  } = options;

  const rooms = new Map(); // roomId -> Set<WebSocket>
  const roomLocks = new Map(); // roomId -> boolean (simple mutex for race condition)

  function join(ws, roomId) {
    const meta = getMeta(ws);

    // Validate room ID
    const roomValidation = validateRoomId(roomId);
    if (!roomValidation.valid) {
      safeSend(ws, { type: MSG_TYPES.ERROR, message: roomValidation.reason });
      return false;
    }

    // Check total room limit
    if (!rooms.has(roomId) && rooms.size >= maxRooms) {
      safeSend(ws, {
        type: MSG_TYPES.ERROR,
        message: "Maximum room limit reached",
      });
      return false;
    }

    // Simple lock to prevent race condition
    if (roomLocks.get(roomId)) {
      // Room is being modified, retry after small delay
      setTimeout(() => join(ws, roomId), 10);
      return false;
    }
    roomLocks.set(roomId, true);

    try {
      let room = rooms.get(roomId);
      if (!room) {
        room = new Set();
        rooms.set(roomId, room);
      }

      // If this socket was already in another room, leave it first
      if (meta[roomIdKey] && meta[roomIdKey] !== roomId) {
        leave(ws);
      }

      // Remove any dead sockets
      for (const peer of Array.from(room)) {
        if (peer.readyState !== WebSocket.OPEN) {
          room.delete(peer);
        }
      }

      // If already in this room, nothing to do
      if (room.has(ws)) {
        roomLocks.set(roomId, false);
        return true;
      }

      // Enforce max peers
      if (room.size >= maxPeers) {
        safeSend(ws, { type: MSG_TYPES.ROOM_FULL });
        roomLocks.set(roomId, false);
        return false;
      }

      // Add to room
      room.add(ws);
      meta[roomIdKey] = roomId;

      const isInitiator = trackInitiator ? room.size === 1 : false;
      if (trackInitiator) {
        meta.isInitiator = isInitiator;
      }

      // Send joined confirmation (matches old behavior)
      safeSend(ws, {
        type: MSG_TYPES.JOINED,
        roomId,
        isInitiator,
      });

      // Notify all peers (including this one, maintaining original behavior)
      if (notifyOnJoin) {
        for (const peer of room) {
          if (peer.readyState === WebSocket.OPEN) {
            safeSend(peer, { type: MSG_TYPES.PEER_JOINED, roomId });
          }
        }
      }

      logger.info({ roomId, size: room.size }, `[${name}] join room`);
      return true;
    } finally {
      roomLocks.set(roomId, false);
    }
  }

  function leave(ws) {
    const meta = getMeta(ws);
    const roomId = meta[roomIdKey];
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) {
      meta[roomIdKey] = null;
      return;
    }

    room.delete(ws);

    // Notify remaining peers
    if (notifyOnLeave) {
      for (const peer of room) {
        if (peer.readyState === WebSocket.OPEN) {
          safeSend(peer, { type: MSG_TYPES.PEER_LEFT, roomId });
        }
      }
    }

    const remainingSize = room.size;
    if (remainingSize === 0) {
      rooms.delete(roomId);
      roomLocks.delete(roomId);
    }

    meta[roomIdKey] = null;

    logger.info({ roomId, size: remainingSize }, `[${name}] leave room`);
  }

  function broadcast(ws, message) {
    const meta = getMeta(ws);
    const roomId = meta[roomIdKey];
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const payload = JSON.stringify(message); // Stringify once
    for (const peer of room) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(payload);
        } catch (err) {
          logger.warn({ err }, "[WebRTC] Failed to send message");
        }
      }
    }
  }

  function getRoom(ws) {
    const meta = getMeta(ws);
    const roomId = meta[roomIdKey];
    if (!roomId) return null;
    return rooms.get(roomId) || null;
  }

  function getRoomId(ws) {
    return getMeta(ws)[roomIdKey];
  }

  function getRoomCount() {
    return rooms.size;
  }

  function getAllSockets() {
    const allSockets = new Set();
    for (const room of rooms.values()) {
      for (const ws of room) {
        allSockets.add(ws);
      }
    }
    return allSockets;
  }

  return {
    join,
    leave,
    broadcast,
    getRoom,
    getRoomId,
    getRoomCount,
    getAllSockets,
    rooms, // Expose for debugging if needed
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE SEND HELPER
// ═══════════════════════════════════════════════════════════════════════════════
function safeSend(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    ws.send(payload);
    return true;
  } catch (err) {
    logger.warn({ err }, "[WebRTC] Failed to send message");
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION HELPER
// ═══════════════════════════════════════════════════════════════════════════════
function extractTokenFromRequest(request) {
  // From subprotocol header (common for WebSocket auth)
  const protocols = request.headers[CONFIG.AUTH_TOKEN_HEADER];
  if (typeof protocols === "string" && protocols.trim()) {
    const protocolList = protocols.split(",").map((p) => p.trim());
    const candidate = protocolList.find((p) => p && p !== "websocket");
    if (candidate) return candidate;
  }

  // From query string
  try {
    const url = new URL(request.url || "", "http://localhost");
    const token = url.searchParams.get("token");
    if (token) return token;
  } catch {
    // Ignore URL parsing errors
  }

  // From Authorization header (if custom headers are supported)
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
      resolve(sessionData || null);
    });
  });
}

async function authenticateFromSession(request) {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return null;

  const sessionData = await getSessionById(sessionId);
  const sessionUser = sessionData?.user;
  if (!sessionUser?.id) return null;

  return { authenticated: true, userId: String(sessionUser.id) };
}

async function authenticateConnection(request) {
  if (!CONFIG.AUTH_ENABLED) {
    return { authenticated: true, userId: "anonymous" };
  }

  try {
    // Primary path: existing app session cookie.
    const sessionAuth = await authenticateFromSession(request);
    if (sessionAuth) return sessionAuth;

    // Fallback path: token-based auth (if caller passes token explicitly).
    const token = extractTokenFromRequest(request);

    if (!token) {
      return {
        authenticated: false,
        reason: "No valid session or token provided",
      };
    }

    const result = await CONFIG.validateToken(token, request);
    if (result.valid) {
      return { authenticated: true, userId: result.userId };
    } else {
      return { authenticated: false, reason: result.reason || "Invalid token" };
    }
  } catch (err) {
    logger.error({ err }, "[Auth] Authentication error");
    return { authenticated: false, reason: "Authentication error" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SETUP FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════
export function setupWebRtcSignaling(httpServer) {
  // Create two WS servers (noServer = true)
  const wssPrep = new WebSocketServer({
    noServer: true,
    maxPayload: CONFIG.MAX_MESSAGE_SIZE_BYTES,
  });
  const wssClassroom = new WebSocketServer({
    noServer: true,
    maxPayload: CONFIG.MAX_MESSAGE_SIZE_BYTES,
  });

  // ✅ NEW: draining mode (reject new upgrades during deploy shutdown)
  let isDraining = false;

  // ─────────────────────────────────────────────
  // Room Managers
  // ─────────────────────────────────────────────
  const videoRoomManager = createRoomManager({
    name: "WebRTC",
    maxPeers: CONFIG.MAX_VIDEO_PEERS,
    maxRooms: CONFIG.MAX_TOTAL_ROOMS,
    roomIdKey: "videoRoomId",
    notifyOnJoin: true,
    notifyOnLeave: true,
    trackInitiator: true,
  });

  const classroomRoomManager = createRoomManager({
    name: "Classroom",
    maxPeers: CONFIG.MAX_CLASSROOM_PEERS,
    maxRooms: CONFIG.MAX_TOTAL_ROOMS,
    roomIdKey: "classroomRoomId",
    notifyOnJoin: false,
    notifyOnLeave: false,
    trackInitiator: false,
  });

  // ─────────────────────────────────────────────
  // Heartbeat intervals
  // ─────────────────────────────────────────────
  let heartbeatIntervalPrep = null;
  let heartbeatIntervalClassroom = null;

  if (CONFIG.HEARTBEAT_ENABLED) {
    // Heartbeat for /ws/prep
    heartbeatIntervalPrep = setInterval(() => {
      wssPrep.clients.forEach((ws) => {
        const meta = getMeta(ws);
        if (!meta.isAlive) {
          logger.info("[WebRTC] Terminating unresponsive connection");
          videoRoomManager.leave(ws);
          untrackConnection(ws);
          return ws.terminate();
        }
        meta.isAlive = false;
        ws.ping();
      });
    }, CONFIG.HEARTBEAT_INTERVAL_MS);

    // Heartbeat for /ws/classroom
    heartbeatIntervalClassroom = setInterval(() => {
      wssClassroom.clients.forEach((ws) => {
        const meta = getMeta(ws);
        if (!meta.isAlive) {
          logger.info("[Classroom] Terminating unresponsive connection");
          classroomRoomManager.leave(ws);
          untrackConnection(ws);
          return ws.terminate();
        }
        meta.isAlive = false;
        ws.ping();
      });
    }, CONFIG.HEARTBEAT_INTERVAL_MS);
  }

  // ✅ NEW: if a WS server closes, stop its heartbeat interval
  wssPrep.on("close", () => {
    if (heartbeatIntervalPrep) clearInterval(heartbeatIntervalPrep);
  });

  wssClassroom.on("close", () => {
    if (heartbeatIntervalClassroom) clearInterval(heartbeatIntervalClassroom);
  });

  // ─────────────────────────────────────────────
  // Message handler factory
  // ─────────────────────────────────────────────
  function createMessageHandler(roomManager, channelName) {
    return (ws, raw) => {
      // Rate limiting
      if (!checkRateLimit(ws)) {
        safeSend(ws, { type: MSG_TYPES.ERROR, message: "Rate limit exceeded" });
        return;
      }

      // Parse message
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        safeSend(ws, { type: MSG_TYPES.ERROR, message: "Invalid JSON" });
        return;
      }

      if (!msg || !msg.type) {
        safeSend(ws, {
          type: MSG_TYPES.ERROR,
          message: "Missing message type",
        });
        return;
      }

      // Handle different message types
      switch (msg.type) {
        case MSG_TYPES.JOIN: {
          const { roomId } = msg;
          const validation = validateRoomId(roomId);
          if (!validation.valid) {
            safeSend(ws, { type: MSG_TYPES.ERROR, message: validation.reason });
            return;
          }
          roomManager.join(ws, roomId);
          break;
        }

        case MSG_TYPES.LEAVE: {
          roomManager.leave(ws);
          break;
        }

        case MSG_TYPES.SIGNAL: {
          const roomId = roomManager.getRoomId(ws);
          if (!roomId) {
            safeSend(ws, { type: MSG_TYPES.ERROR, message: "Not in a room" });
            return;
          }

          // Validate signal payload (now relaxed for type, but still checks presence + size)
          const signalValidation = validateSignalPayload(msg);
          if (!signalValidation.valid) {
            safeSend(ws, {
              type: MSG_TYPES.ERROR,
              message: signalValidation.reason,
            });
            return;
          }

          // Forward to other peers (matches old behavior)
          roomManager.broadcast(ws, {
            type: MSG_TYPES.SIGNAL,
            signalType: msg.signalType,
            data: msg.data,
          });
          break;
        }

        default:
          // Unknown message type - ignore silently (or send error)
          logger.debug(
            { type: msg.type },
            `[${channelName}] Unknown message type`
          );
          break;
      }
    };
  }

  // ─────────────────────────────────────────────
  // Connection handler factory
  // ─────────────────────────────────────────────
  function createConnectionHandler(roomManager, channelName, messageHandler) {
    return (ws, request) => {
      const ip = getClientIP(request);
      const meta = getMeta(ws);
      meta.ip = ip;

      logger.info({ ip }, `[${channelName}] Client connected`);

      // Track connection
      trackConnection(ws, ip);

      // Set up heartbeat response
      if (CONFIG.HEARTBEAT_ENABLED) {
        meta.isAlive = true;
        ws.on("pong", () => {
          meta.isAlive = true;
        });
      }

      // Message handler
      ws.on("message", (raw) => {
        // Check message size (defense in depth, WebSocketServer also checks)
        if (raw.length > CONFIG.MAX_MESSAGE_SIZE_BYTES) {
          safeSend(ws, { type: MSG_TYPES.ERROR, message: "Message too large" });
          return;
        }
        messageHandler(ws, raw);
      });

      // Close handler
      ws.on("close", () => {
        roomManager.leave(ws);
        untrackConnection(ws);
        logger.info({ ip }, `[${channelName}] Client disconnected`);
      });

      // Error handler
      ws.on("error", (err) => {
        logger.error({ err, ip }, `[${channelName}] WebSocket error`);
        roomManager.leave(ws);
        untrackConnection(ws);
        // Ensure socket is terminated
        try {
          ws.terminate();
        } catch {
          // Ignore termination errors
        }
      });
    };
  }

  // ─────────────────────────────────────────────
  // Set up handlers for both channels
  // ─────────────────────────────────────────────
  const prepMessageHandler = createMessageHandler(videoRoomManager, "WebRTC");
  const classroomMessageHandler = createMessageHandler(
    classroomRoomManager,
    "Classroom"
  );

  wssPrep.on(
    "connection",
    createConnectionHandler(videoRoomManager, "WebRTC", prepMessageHandler)
  );

  wssClassroom.on(
    "connection",
    createConnectionHandler(
      classroomRoomManager,
      "Classroom",
      classroomMessageHandler
    )
  );

  // ─────────────────────────────────────────────
  // HTTP Upgrade handling with security checks
  // ─────────────────────────────────────────────
  httpServer.on("upgrade", async (request, socket, head) => {
    const ip = getClientIP(request);

    // Parse pathname
    let pathname = "/";
    try {
      const url = new URL(request.url || "", "http://localhost");
      pathname = url.pathname || "/";
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // ✅ NEW: during shutdown/redeploy, reject new WS upgrades
    if (isDraining) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    // Check if this is one of our paths
    if (pathname !== "/ws/prep" && pathname !== "/ws/classroom") {
      socket.destroy();
      return;
    }

    // Origin validation
    if (!validateOrigin(request)) {
      logger.warn(
        { ip, origin: request.headers.origin },
        "[Security] Origin validation failed"
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Connection limit check
    const connectionCheck = canAcceptConnection(ip);
    if (!connectionCheck.allowed) {
      logger.warn(
        { ip, reason: connectionCheck.reason },
        "[Security] Connection rejected"
      );
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    // Authentication
    const authResult = await authenticateConnection(request);
    if (!authResult.authenticated) {
      logger.warn(
        { ip, reason: authResult.reason },
        "[Security] Authentication failed"
      );
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Route to appropriate WebSocket server
    const wss = pathname === "/ws/prep" ? wssPrep : wssClassroom;

    wss.handleUpgrade(request, socket, head, (ws) => {
      // Store authenticated user ID
      getMeta(ws).userId = authResult.userId;
      wss.emit("connection", ws, request);
    });
  });

  // ─────────────────────────────────────────────
  // Graceful shutdown handler
  const shutdown = (signal) => {
    // ✅ NEW: stop accepting new WS upgrades immediately
    isDraining = true;

    logger.info({ signal }, "[Server] Graceful shutdown initiated");

    // Clear heartbeat intervals
    if (heartbeatIntervalPrep) {
      clearInterval(heartbeatIntervalPrep);
    }

    if (heartbeatIntervalClassroom) {
      clearInterval(heartbeatIntervalClassroom);
    }

    // Close all WebSocket connections gracefully
    const closePromises = [];

    const closeConnection = (ws, channelName) => {
      return new Promise((resolve) => {
        try {
          ws.close(1001, "Server shutting down");
          // Give client time to receive close frame
          setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) {
              ws.terminate();
            }
            resolve();
          }, 1000);
        } catch {
          resolve();
        }
      });
    };

    wssPrep.clients.forEach((ws) => {
      closePromises.push(closeConnection(ws, "WebRTC"));
    });

    wssClassroom.clients.forEach((ws) => {
      closePromises.push(closeConnection(ws, "Classroom"));
    });

    Promise.all(closePromises).then(() => {
      logger.info("[Server] All WebSocket connections closed");
      // Close the WebSocket servers
      wssPrep.close();
      wssClassroom.close();
    });
  };

  // Register shutdown handlers
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ─────────────────────────────────────────────
  // Health check / stats endpoint (optional)
  // ─────────────────────────────────────────────
  const getStats = () => ({
    totalConnections,
    videoRooms: videoRoomManager.getRoomCount(),
    classroomRooms: classroomRoomManager.getRoomCount(),
    prepClients: wssPrep.clients.size,
    classroomClients: wssClassroom.clients.size,
  });

  if (!CONFIG.AUTH_ENABLED) {
    logger.warn(
      "[Security] WebSocket auth is disabled (WS_AUTH_ENABLED=false). This should never be used in production."
    );
  }

  if (CONFIG.ALLOWED_ORIGINS.length === 0) {
    logger.warn(
      "[Security] WebSocket origin allowlist is empty. Set WS_ALLOWED_ORIGINS or ALLOWED_ORIGINS."
    );
  }

  logger.info("[WebRTC] Signaling server ready at /ws/prep");
  logger.info("[Classroom] Signaling server ready at /ws/classroom");

  // Return useful references for testing/monitoring
  return {
    wssPrep,
    wssClassroom,
    videoRoomManager,
    classroomRoomManager,
    getStats,
    shutdown,
    CONFIG, // Expose config for runtime modification if needed
  };
}
