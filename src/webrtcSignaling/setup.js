// src/webrtcSignaling/setup.js

import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../lib/logger.js";
import { CONFIG, MSG_TYPES, validateOrigin } from "./config.js";
import { getMeta } from "./socketMeta.js";
import {
  trackConnection,
  untrackConnection,
  canAcceptConnection,
  getTotalConnections,
} from "./connectionTracker.js";
import { getClientIP } from "./requestUtils.js";
import { checkRateLimit, validateRoomId, validateSignalPayload } from "./validation.js";
import { createRoomManager } from "./roomManager.js";
import { safeSend } from "./transport.js";
import { authenticateConnection } from "./auth.js";
import { authorizeClassroomJoin } from "./classroomAuthorization.js";

function setupWebRtcSignaling(httpServer) {
  const wssPrep = new WebSocketServer({
    noServer: true,
    maxPayload: CONFIG.MAX_MESSAGE_SIZE_BYTES,
  });
  const wssClassroom = new WebSocketServer({
    noServer: true,
    maxPayload: CONFIG.MAX_MESSAGE_SIZE_BYTES,
  });

  let isDraining = false;

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

  let heartbeatIntervalPrep = null;
  let heartbeatIntervalClassroom = null;

  if (CONFIG.HEARTBEAT_ENABLED) {
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

  wssPrep.on("close", () => {
    if (heartbeatIntervalPrep) clearInterval(heartbeatIntervalPrep);
  });

  wssClassroom.on("close", () => {
    if (heartbeatIntervalClassroom) clearInterval(heartbeatIntervalClassroom);
  });

  function createMessageHandler(roomManager, channelName, options = {}) {
    const { authorizeJoin = null } = options;

    return async (ws, raw) => {
      if (!checkRateLimit(ws)) {
        safeSend(ws, { type: MSG_TYPES.ERROR, message: "Rate limit exceeded" });
        return;
      }

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

      switch (msg.type) {
        case MSG_TYPES.JOIN: {
          const { roomId } = msg;
          const validation = validateRoomId(roomId);
          if (!validation.valid) {
            safeSend(ws, { type: MSG_TYPES.ERROR, message: validation.reason });
            return;
          }

          if (typeof authorizeJoin === "function") {
            const meta = getMeta(ws);
            const authorization = await authorizeJoin({
              roomId,
              userId: meta.userId,
              ws,
            });

            if (!authorization.allowed) {
              logger.warn(
                {
                  roomId,
                  userId: meta.userId,
                  reason: authorization.reason,
                },
                `[${channelName}] Forbidden room join`
              );
              safeSend(ws, { type: MSG_TYPES.ERROR, message: "Forbidden" });
              try {
                ws.close(1008, "Forbidden");
              } catch {
                // Ignore close errors.
              }
              return;
            }
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

          const signalValidation = validateSignalPayload(msg);
          if (!signalValidation.valid) {
            safeSend(ws, {
              type: MSG_TYPES.ERROR,
              message: signalValidation.reason,
            });
            return;
          }

          roomManager.broadcast(ws, {
            type: MSG_TYPES.SIGNAL,
            signalType: msg.signalType,
            data: msg.data,
          });
          break;
        }

        default:
          logger.debug({ type: msg.type }, `[${channelName}] Unknown message type`);
          break;
      }
    };
  }

  function createConnectionHandler(roomManager, channelName, messageHandler) {
    return (ws, request) => {
      const ip = getClientIP(request);
      const meta = getMeta(ws);
      meta.ip = ip;

      logger.info({ ip }, `[${channelName}] Client connected`);

      trackConnection(ws, ip);

      if (CONFIG.HEARTBEAT_ENABLED) {
        meta.isAlive = true;
        ws.on("pong", () => {
          meta.isAlive = true;
        });
      }

      ws.on("message", (raw) => {
        if (raw.length > CONFIG.MAX_MESSAGE_SIZE_BYTES) {
          safeSend(ws, { type: MSG_TYPES.ERROR, message: "Message too large" });
          return;
        }
        Promise.resolve(messageHandler(ws, raw)).catch((err) => {
          logger.error({ err, ip }, `[${channelName}] Message handler failed`);
          safeSend(ws, { type: MSG_TYPES.ERROR, message: "Server error" });
        });
      });

      ws.on("close", () => {
        roomManager.leave(ws);
        untrackConnection(ws);
        logger.info({ ip }, `[${channelName}] Client disconnected`);
      });

      ws.on("error", (err) => {
        logger.error({ err, ip }, `[${channelName}] WebSocket error`);
        roomManager.leave(ws);
        untrackConnection(ws);
        try {
          ws.terminate();
        } catch {
          // Ignore termination errors
        }
      });
    };
  }

  const prepMessageHandler = createMessageHandler(videoRoomManager, "WebRTC");
  const classroomMessageHandler = createMessageHandler(
    classroomRoomManager,
    "Classroom",
    { authorizeJoin: authorizeClassroomJoin }
  );

  wssPrep.on(
    "connection",
    createConnectionHandler(videoRoomManager, "WebRTC", prepMessageHandler)
  );

  wssClassroom.on(
    "connection",
    createConnectionHandler(classroomRoomManager, "Classroom", classroomMessageHandler)
  );

  httpServer.on("upgrade", async (request, socket, head) => {
    if (request.__wsHandled) {
      return;
    }

    const ip = getClientIP(request);

    let pathname = "/";
    try {
      const url = new URL(request.url || "", "http://localhost");
      pathname = url.pathname || "/";
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    if (isDraining) {
      socket.write("HTTP/1.1 503 Service Unavailable\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    if (pathname !== "/ws/prep" && pathname !== "/ws/classroom") {
      socket.destroy();
      return;
    }

    const connectionCheck = canAcceptConnection(ip);
    if (!connectionCheck.allowed) {
      logger.warn(
        { ip, reason: connectionCheck.reason },
        "[Security] Connection rejected"
      );
      socket.write("HTTP/1.1 503 Service Unavailable\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    const authResult = await authenticateConnection(request);
    if (!authResult.authenticated) {
      logger.warn(
        { ip, reason: authResult.reason },
        "[Security] Authentication failed"
      );
      socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    const originAllowed = validateOrigin(request);
    if (!originAllowed && authResult.authSource !== "token") {
      logger.warn(
        { ip, origin: request.headers.origin },
        "[Security] Origin validation failed"
      );
      socket.write("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
      socket.destroy();
      return;
    }
    if (!originAllowed && authResult.authSource === "token") {
      logger.info(
        { ip, origin: request.headers.origin },
        "[Security] Origin bypass allowed for token-authenticated WebSocket"
      );
    }

    const wss = pathname === "/ws/prep" ? wssPrep : wssClassroom;

    request.__wsHandled = true;
    wss.handleUpgrade(request, socket, head, (ws) => {
      const meta = getMeta(ws);
      meta.userId = authResult.userId;
      meta.authSource = authResult.authSource;
      wss.emit("connection", ws, request);
    });
  });

  const shutdown = (signal) => {
    isDraining = true;

    logger.info({ signal }, "[Server] Graceful shutdown initiated");

    if (heartbeatIntervalPrep) {
      clearInterval(heartbeatIntervalPrep);
    }

    if (heartbeatIntervalClassroom) {
      clearInterval(heartbeatIntervalClassroom);
    }

    const closePromises = [];

    const closeConnection = (ws, channelName) => {
      return new Promise((resolve) => {
        try {
          ws.close(1001, "Server shutting down");
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
      wssPrep.close();
      wssClassroom.close();
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const getStats = () => ({
    totalConnections: getTotalConnections(),
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

  return {
    wssPrep,
    wssClassroom,
    videoRoomManager,
    classroomRoomManager,
    getStats,
    shutdown,
    CONFIG,
  };
}

export { setupWebRtcSignaling };
