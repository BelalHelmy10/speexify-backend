// src/webrtcSignaling/setup.js

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
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
import { validateRoomId, validateSignalPayload } from "./validation.js";
import { createRoomManager } from "./roomManager.js";
import { safeSend } from "./transport.js";
import { authenticateConnection } from "./auth.js";
import { authorizeClassroomJoin } from "./classroomAuthorization.js";
import { consumeRateLimit } from "../services/rateLimitService.js";
import { onRealtimeEvent, publishRealtimeEvent, startRealtimeBus } from "../services/realtimeBus.js";
import {
  acquireConnection,
  releaseConnection,
  touchConnection,
} from "../services/distributedState.js";

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

  const publishRoomEvent = (event) => publishRealtimeEvent("webrtc-room", event);

  const videoRoomManager = createRoomManager({
    name: "WebRTC",
    maxPeers: CONFIG.MAX_VIDEO_PEERS,
    maxRooms: CONFIG.MAX_TOTAL_ROOMS,
    roomIdKey: "videoRoomId",
    notifyOnJoin: true,
    notifyOnLeave: true,
    trackInitiator: true,
    channelName: "prep",
    roomLeaseMs: CONFIG.DISTRIBUTED_STATE_LEASE_MS,
    publishRoomEvent,
  });

  const classroomRoomManager = createRoomManager({
    name: "Classroom",
    maxPeers: CONFIG.MAX_CLASSROOM_PEERS,
    maxRooms: CONFIG.MAX_TOTAL_ROOMS,
    roomIdKey: "classroomRoomId",
    notifyOnJoin: false,
    notifyOnLeave: false,
    trackInitiator: false,
    channelName: "classroom",
    roomLeaseMs: CONFIG.DISTRIBUTED_STATE_LEASE_MS,
    publishRoomEvent,
  });

  onRealtimeEvent("webrtc-room", (event) => {
    videoRoomManager.handleRemoteEvent(event);
    classroomRoomManager.handleRemoteEvent(event);
  });
  void startRealtimeBus().catch((err) => logger.error({ err }, "[WebRTC] Realtime bus failed to start"));

  let heartbeatIntervalPrep = null;
  let heartbeatIntervalClassroom = null;

  if (CONFIG.HEARTBEAT_ENABLED) {
    heartbeatIntervalPrep = setInterval(() => {
      wssPrep.clients.forEach((ws) => {
        const meta = getMeta(ws);
        if (!meta.isAlive) {
          logger.info("[WebRTC] Terminating unresponsive connection");
          void videoRoomManager.leave(ws);
          meta.distributedReleased = true;
          void releaseConnection({ connectionId: meta.connectionId, ip: meta.ip });
          untrackConnection(ws);
          return ws.terminate();
        }
        meta.isAlive = false;
        void videoRoomManager.touch(ws);
        void touchConnection({ connectionId: meta.connectionId, ip: meta.ip, leaseMs: CONFIG.DISTRIBUTED_STATE_LEASE_MS });
        ws.ping();
      });
    }, CONFIG.HEARTBEAT_INTERVAL_MS);

    heartbeatIntervalClassroom = setInterval(() => {
      wssClassroom.clients.forEach((ws) => {
        const meta = getMeta(ws);
        if (!meta.isAlive) {
          logger.info("[Classroom] Terminating unresponsive connection");
          void classroomRoomManager.leave(ws);
          meta.distributedReleased = true;
          void releaseConnection({ connectionId: meta.connectionId, ip: meta.ip });
          untrackConnection(ws);
          return ws.terminate();
        }
        meta.isAlive = false;
        void classroomRoomManager.touch(ws);
        void touchConnection({ connectionId: meta.connectionId, ip: meta.ip, leaseMs: CONFIG.DISTRIBUTED_STATE_LEASE_MS });
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
      const meta = getMeta(ws);
      if (CONFIG.RATE_LIMIT_ENABLED) {
        const rateLimit = await consumeRateLimit({
          key: `websocket:${channelName}:${meta.userId || meta.ip || "unknown"}`,
          limit: CONFIG.RATE_LIMIT_MAX_MESSAGES,
          windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
        });
        if (rateLimit.unavailable) {
          safeSend(ws, {
            type: MSG_TYPES.ERROR,
            message: "Shared rate limiting is temporarily unavailable",
          });
          return;
        }
        if (!rateLimit.allowed) {
          safeSend(ws, { type: MSG_TYPES.ERROR, message: "Rate limit exceeded" });
          return;
        }
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
              safeSend(ws, {
                type: MSG_TYPES.ERROR,
                code: authorization.reason || "forbidden_classroom_room",
                message:
                  authorization.reason === "classroom_admission_required"
                    ? "Waiting for teacher admission"
                    : authorization.reason === "classroom_ended"
                      ? "This classroom session has ended"
                      : "Forbidden",
              });
              try {
                ws.close(1008, "Forbidden");
              } catch {
                // Ignore close errors.
              }
              return;
            }
          }

          await roomManager.join(ws, roomId);
          break;
        }

        case MSG_TYPES.LEAVE: {
          await roomManager.leave(ws);
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
      meta.connectionId = request.__distributedConnectionId || randomUUID();

      const releaseDistributedConnection = () => {
        if (meta.distributedReleased) return;
        meta.distributedReleased = true;
        void releaseConnection({ connectionId: meta.connectionId, ip });
      };

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
        void roomManager.leave(ws);
        releaseDistributedConnection();
        untrackConnection(ws);
        logger.info({ ip }, `[${channelName}] Client disconnected`);
      });

      ws.on("error", (err) => {
        logger.error({ err, ip }, `[${channelName}] WebSocket error`);
        void roomManager.leave(ws);
        releaseDistributedConnection();
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

    const distributedConnectionId = randomUUID();
    const distributedCheck = await acquireConnection({
      connectionId: distributedConnectionId,
      ip,
      maxTotal: CONFIG.MAX_CONNECTIONS_TOTAL,
      maxPerIp: CONFIG.MAX_CONNECTIONS_PER_IP,
      leaseMs: CONFIG.DISTRIBUTED_STATE_LEASE_MS,
    });
    if (!distributedCheck.allowed) {
      logger.warn({ ip, reason: distributedCheck.reason }, "[Security] Distributed connection capacity rejected");
      socket.write("HTTP/1.1 503 Service Unavailable\\r\\n\\r\\n");
      socket.destroy();
      return;
    }

    const wss = pathname === "/ws/prep" ? wssPrep : wssClassroom;

    request.__wsHandled = true;
    request.__distributedConnectionId = distributedConnectionId;
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
