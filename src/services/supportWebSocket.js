// src/services/supportWebSocket.js
import { WebSocketServer } from "ws";
import { parse as parseCookie } from "cookie";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

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
    path: "/ws/support",
  });

  // Handle upgrade requests
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname === "/ws/support") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", async (ws, request) => {
    try {
      // Extract session from cookie
      const cookies = parseCookie(request.headers.cookie || "");
      const sessionId = cookies["speexify.sid"];

      if (!sessionId) {
        ws.close(1008, "No session");
        return;
      }

      // Get user from session (you'll need to implement this based on your session store)
      const user = await getUserFromSession(sessionId);

      if (!user) {
        ws.close(1008, "Invalid session");
        return;
      }

      // Track connection
      const isAdmin = user.role === "admin";

      if (isAdmin) {
        adminConnections.add(ws);
      } else {
        if (!userConnections.has(user.id)) {
          userConnections.set(user.id, new Set());
        }
        userConnections.get(user.id).add(ws);
      }

      logger.info({ userId: user.id, isAdmin }, "Support WebSocket connected");

      // Send connection confirmation
      ws.send(
        JSON.stringify({
          type: "connected",
          userId: user.id,
          isAdmin,
        })
      );

      // Handle incoming messages
      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());
          await handleWebSocketMessage(ws, user, message);
        } catch (err) {
          logger.error({ err, userId: user.id }, "WebSocket message error");
          ws.send(
            JSON.stringify({
              type: "error",
              error: "Invalid message format",
            })
          );
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
      ws.close(1011, "Internal error");
    }
  });

  return wss;
}

/**
 * Handle WebSocket messages
 */
async function handleWebSocketMessage(ws, user, message) {
  const { type, data } = message;

  switch (type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      break;

    case "typing":
      // Broadcast typing indicator
      if (data.ticketId) {
        await broadcastTypingIndicator(data.ticketId, user, data.isTyping);
      }
      break;

    case "subscribe":
      // Subscribe to specific ticket updates
      if (data.ticketId) {
        ws.ticketSubscriptions = ws.ticketSubscriptions || new Set();
        ws.ticketSubscriptions.add(data.ticketId);
      }
      break;

    default:
      logger.warn({ type, userId: user.id }, "Unknown WebSocket message type");
  }
}

/**
 * Broadcast typing indicator
 */
async function broadcastTypingIndicator(ticketId, user, isTyping) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { userId: true },
  });

  if (!ticket) return;

  const message = JSON.stringify({
    type: "typing",
    ticketId,
    userId: user.id,
    userName: user.name || user.email,
    isTyping,
  });

  // Send to ticket owner
  const ownerConnections = userConnections.get(ticket.userId);
  if (ownerConnections) {
    ownerConnections.forEach((ws) => {
      if (ws.readyState === 1) ws.send(message);
    });
  }

  // Send to all admins
  adminConnections.forEach((ws) => {
    if (ws.readyState === 1) ws.send(message);
  });
}

/**
 * Broadcast new message to relevant connections
 */
export function broadcastNewMessage(ticketId, message, ticket) {
  const payload = JSON.stringify({
    type: "new_message",
    ticketId,
    message,
    ticket,
  });

  // Send to ticket owner
  const ownerConnections = userConnections.get(ticket.userId);
  if (ownerConnections) {
    ownerConnections.forEach((ws) => {
      if (ws.readyState === 1) ws.send(payload);
    });
  }

  // Send to all admins
  adminConnections.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

/**
 * Broadcast ticket status change
 */
export function broadcastTicketStatusChange(ticketId, status, ticket) {
  const payload = JSON.stringify({
    type: "ticket_status_change",
    ticketId,
    status,
    ticket,
  });

  // Send to ticket owner
  const ownerConnections = userConnections.get(ticket.userId);
  if (ownerConnections) {
    ownerConnections.forEach((ws) => {
      if (ws.readyState === 1) ws.send(payload);
    });
  }

  // Send to all admins
  adminConnections.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

/**
 * Broadcast new ticket to admins
 */
export function broadcastNewTicket(ticket) {
  const payload = JSON.stringify({
    type: "new_ticket",
    ticket,
  });

  adminConnections.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

/**
 * Get user from session (implement based on your session store)
 */
async function getUserFromSession(sessionId) {
  // This is a placeholder - implement based on your session store
  // For express-session with Redis:
  try {
    // You'll need to import your session store and decode the session
    // For now, returning null to show the structure
    // In production, decode the session ID and fetch from Redis

    // Example with connect-redis:
    // const session = await redisClient.get(`sess:${sessionId}`);
    // if (!session) return null;
    // const parsed = JSON.parse(session);
    // return parsed.user;

    return null; // Implement this
  } catch (err) {
    logger.error({ err }, "Failed to get user from session");
    return null;
  }
}

// Export connection maps for testing/debugging
export { userConnections, adminConnections };
