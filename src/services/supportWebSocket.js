// src/services/supportWebSocket.js
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookie } from "cookie";
import { unsign as unsignCookieValue } from "cookie-signature";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ALLOWED_ORIGINS, SESSION_SECRET, isProd } from "../config/env.js";
import { SESSION_COOKIE_NAME } from "../config/session.js";
import { sessionMiddleware } from "../middleware/session.js";
import { verifyWsAuthToken } from "../webrtcSignaling/token.js";

const OPEN_STATE = WebSocket.OPEN;
const MAX_MESSAGE_SIZE_BYTES = 1_048_576;
const wsAllowedOrigins = ALLOWED_ORIGINS.map((origin) =>
  String(origin || "")
    .trim()
    .replace(/\/+$/, "")
).filter(Boolean);

// Store active connections: Map<userId, Set<WebSocket>>
const userConnections = new Map();

// Store admin connections: Set<WebSocket>
const adminConnections = new Set();

/**
 * Setup WebSocket server for real-time support
 */
export function setupSupportWebSocket(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_SIZE_BYTES,
  });

  // Handle upgrade requests
  server.on("upgrade", (request, socket, head) => {
    if (request.__wsHandled) return;

    let pathname = "/";
    try {
      const parsed = new URL(request.url || "", "http://localhost");
      pathname = parsed.pathname || "/";
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname !== "/ws/support") {
      return;
    }

    if (!validateOrigin(request)) {
      logger.warn(
        { origin: request.headers.origin },
        "[Support WS] Origin validation failed"
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    request.__wsHandled = true;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", async (ws, request) => {
    let currentUser = null;
    let isAdmin = false;

    try {
      const authResult = await authenticateFromSession(request);
      if (!authResult.authenticated) {
        ws.close(1008, authResult.reason || "Unauthorized");
        return;
      }

      const { user, actorUserId, isImpersonating } = authResult;
      currentUser = user;
      isAdmin = user.role === "admin";

      // Track connection
      if (isAdmin) {
        adminConnections.add(ws);
      } else {
        if (!userConnections.has(user.id)) {
          userConnections.set(user.id, new Set());
        }
        userConnections.get(user.id).add(ws);
      }

      logger.info(
        { userId: user.id, actorUserId, isAdmin, isImpersonating },
        "Support WebSocket connected"
      );

      // Send connection confirmation
      safeSend(ws, {
        type: "connected",
        userId: user.id,
        isAdmin,
      });

      // Handle incoming messages
      ws.on("message", async (data) => {
        if (data.length > MAX_MESSAGE_SIZE_BYTES) {
          safeSend(ws, {
            type: "error",
            error: "Message too large",
          });
          return;
        }

        try {
          const message = JSON.parse(data.toString());
          await handleWebSocketMessage(ws, user, message);
        } catch (err) {
          logger.error({ err, userId: user.id }, "WebSocket message error");
          safeSend(ws, {
            type: "error",
            error: "Invalid message format",
          });
        }
      });

      // Handle disconnection
      ws.on("close", () => {
        if (isAdmin) {
          adminConnections.delete(ws);
        } else {
          const connections = userConnections.get(user.id);
          if (connections) {
            connections.delete(ws);
            if (connections.size === 0) {
              userConnections.delete(user.id);
            }
          }
        }

        logger.info(
          { userId: user.id, isAdmin },
          "Support WebSocket disconnected"
        );
      });

      // Handle errors
      ws.on("error", (err) => {
        logger.error({ err, userId: user.id }, "WebSocket error");
      });
    } catch (err) {
      logger.error({ err }, "WebSocket connection error");

      if (currentUser) {
        if (isAdmin) {
          adminConnections.delete(ws);
        } else {
          const connections = userConnections.get(currentUser.id);
          if (connections) {
            connections.delete(ws);
            if (connections.size === 0) {
              userConnections.delete(currentUser.id);
            }
          }
        }
      }

      ws.close(1011, "Internal error");
    }
  });

  logger.info("[Support WS] Real-time support server ready at /ws/support");
  return wss;
}

/**
 * Handle WebSocket messages
 */
async function handleWebSocketMessage(ws, user, message) {
  const { type, data } = message || {};

  switch (type) {
    case "ping":
      safeSend(ws, { type: "pong" });
      break;

    case "typing": {
      const ticketId = Number(data?.ticketId);
      if (!Number.isFinite(ticketId)) {
        safeSend(ws, { type: "error", error: "Invalid ticketId" });
        return;
      }

      const ticket = await getAuthorizedTicketForUser(user, ticketId);
      if (!ticket) {
        safeSend(ws, { type: "error", error: "Forbidden" });
        return;
      }

      // Broadcast typing indicator
      await broadcastTypingIndicator(ticket, user, Boolean(data?.isTyping));
      break;
    }

    case "subscribe": {
      const ticketId = Number(data?.ticketId);
      if (!Number.isFinite(ticketId)) {
        safeSend(ws, { type: "error", error: "Invalid ticketId" });
        return;
      }

      const ticket = await getAuthorizedTicketForUser(user, ticketId);
      if (!ticket) {
        safeSend(ws, { type: "error", error: "Forbidden" });
        return;
      }

      // Subscribe to specific ticket updates
      ws.ticketSubscriptions = ws.ticketSubscriptions || new Set();
      ws.ticketSubscriptions.add(ticket.id);
      break;
    }

    default:
      logger.warn({ type, userId: user.id }, "Unknown WebSocket message type");
  }
}

/**
 * Broadcast typing indicator
 */
async function broadcastTypingIndicator(ticket, user, isTyping) {
  const message = JSON.stringify({
    type: "typing",
    ticketId: ticket.id,
    userId: user.id,
    userName: user.name || user.email,
    isTyping,
  });

  // Send to ticket owner
  const ownerConnections = userConnections.get(ticket.userId);
  if (ownerConnections) {
    sendToConnections(ownerConnections, message);
  }

  // Send to all admins
  sendToConnections(adminConnections, message);
}

/**
 * Broadcast new message to relevant connections
 */
export function broadcastNewMessage(ticketId, message, ticket) {
  if (!ticket?.userId) return;

  const payload = JSON.stringify({
    type: "new_message",
    ticketId,
    message,
    ticket,
  });

  // Send to ticket owner
  const ownerConnections = userConnections.get(ticket.userId);
  if (ownerConnections) {
    sendToConnections(ownerConnections, payload);
  }

  // Send to all admins
  sendToConnections(adminConnections, payload);
}

/**
 * Broadcast ticket status change
 */
export function broadcastTicketStatusChange(ticketId, status, ticket) {
  if (!ticket?.userId) return;

  const payload = JSON.stringify({
    type: "ticket_status_change",
    ticketId,
    status,
    ticket,
  });

  // Send to ticket owner
  const ownerConnections = userConnections.get(ticket.userId);
  if (ownerConnections) {
    sendToConnections(ownerConnections, payload);
  }

  // Send to all admins
  sendToConnections(adminConnections, payload);
}

/**
 * Broadcast new ticket to admins
 */
export function broadcastNewTicket(ticket) {
  const payload = JSON.stringify({
    type: "new_ticket",
    ticket,
  });

  sendToConnections(adminConnections, payload);
}

function safeSend(ws, data) {
  if (ws.readyState !== OPEN_STATE) return false;
  try {
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
    return true;
  } catch (err) {
    logger.warn({ err }, "[Support WS] Failed to send message");
    return false;
  }
}

function sendToConnections(connections, payload) {
  for (const ws of Array.from(connections)) {
    if (ws.readyState === OPEN_STATE) {
      safeSend(ws, payload);
      continue;
    }
    connections.delete(ws);
  }
}

function validateOrigin(request) {
  if (!wsAllowedOrigins.length) {
    return !isProd;
  }

  const origin = String(request.headers.origin || "")
    .trim()
    .replace(/\/+$/, "");

  if (!origin) {
    return !isProd;
  }

  return wsAllowedOrigins.includes(origin);
}

function getSessionIdFromCookie(request) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return null;

  let cookies = {};
  try {
    cookies = parseCookie(cookieHeader);
  } catch {
    return null;
  }

  const raw = cookies?.[SESSION_COOKIE_NAME];
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Use raw cookie if decoding fails.
  }

  if (!decoded.startsWith("s:")) {
    return decoded || null;
  }

  if (!SESSION_SECRET) return null;
  const unsigned = unsignCookieValue(decoded.slice(2), SESSION_SECRET);
  return unsigned || null;
}

async function getSessionData(sessionId) {
  const store = sessionMiddleware?.store;
  if (!store || typeof store.get !== "function") return null;

  return await new Promise((resolve) => {
    store.get(sessionId, (err, sessionData) => {
      if (err) {
        logger.warn({ err }, "[Support WS] Failed to load session");
        return resolve(null);
      }
      resolve(sessionData || null);
    });
  });
}

function getWsTokenFromRequest(request) {
  try {
    const parsed = new URL(request.url || "", "http://localhost");
    const token = parsed.searchParams.get("token");
    if (token) return token;
  } catch {
    // Ignore URL parsing errors.
  }

  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols === "string" && protocols.trim()) {
    const candidate = protocols
      .split(",")
      .map((item) => item.trim())
      .find((item) => item && item !== "websocket");
    if (candidate) return candidate;
  }

  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

async function authenticateFromWsToken(request) {
  const token = getWsTokenFromRequest(request);
  if (!token) return null;

  const result = verifyWsAuthToken(token);
  if (!result.valid) {
    return { authenticated: false, reason: result.reason || "Invalid token" };
  }

  const effectiveUserId = Number(result.userId);
  if (!Number.isFinite(effectiveUserId)) {
    return { authenticated: false, reason: "Invalid user in token" };
  }

  const user = await prisma.user.findUnique({
    where: { id: effectiveUserId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isDisabled: true,
    },
  });

  if (!user || user.isDisabled) {
    return { authenticated: false, reason: "User is disabled or not found" };
  }

  return {
    authenticated: true,
    user,
    actorUserId: user.id,
    isImpersonating: false,
  };
}

async function authenticateFromSession(request) {
  const tokenAuth = await authenticateFromWsToken(request);
  if (tokenAuth?.authenticated) return tokenAuth;

  const sessionId = getSessionIdFromCookie(request);
  if (!sessionId) {
    return {
      authenticated: false,
      reason: tokenAuth?.reason || "Missing session",
    };
  }

  const sessionData = await getSessionData(sessionId);
  const sessionUser = sessionData?.user;
  if (!sessionUser?.id) {
    return { authenticated: false, reason: "Invalid session" };
  }

  const actorUserId = Number(sessionUser.id);
  if (!Number.isFinite(actorUserId)) {
    return { authenticated: false, reason: "Invalid user in session" };
  }

  let effectiveUserId = actorUserId;
  const rawAsUserId = sessionData?.asUserId;

  if (sessionUser.role === "admin" && rawAsUserId != null) {
    const asUserId = Number(rawAsUserId);
    if (Number.isFinite(asUserId)) {
      effectiveUserId = asUserId;
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: effectiveUserId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isDisabled: true,
    },
  });

  if (!user || user.isDisabled) {
    return { authenticated: false, reason: "User is disabled or not found" };
  }

  return {
    authenticated: true,
    user,
    actorUserId,
    isImpersonating: effectiveUserId !== actorUserId,
  };
}

async function getAuthorizedTicketForUser(user, ticketId) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, userId: true },
  });

  if (!ticket) return null;
  if (user.role !== "admin" && ticket.userId !== user.id) {
    return null;
  }
  return ticket;
}

// Export connection maps for testing/debugging
export { userConnections, adminConnections };
