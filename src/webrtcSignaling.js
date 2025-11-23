// src/webrtcSignaling.js
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./lib/logger.js";

/**
 * Attach a WebSocket server to the existing HTTP server.
 * Room model:
 * - roomId = resourceId (string)
 * - max 2 peers per room
 */
export function setupWebRtcSignaling(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws/prep",
  });

  // roomId -> Set<WebSocket>
  const rooms = new Map();

  function joinRoom(ws, roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = new Set();
      rooms.set(roomId, room);
    }

    if (room.size >= 2) {
      ws.send(JSON.stringify({ type: "room-full" }));
      ws.close();
      return;
    }

    room.add(ws);
    ws.roomId = roomId;

    const isInitiator = room.size === 1;
    ws.isInitiator = isInitiator;

    ws.send(
      JSON.stringify({
        type: "joined",
        roomId,
        isInitiator,
      })
    );

    // Notify the other peer that someone joined
    for (const peer of room) {
      if (peer !== ws) {
        peer.send(
          JSON.stringify({
            type: "peer-joined",
            roomId,
          })
        );
      }
    }
  }

  function leaveRoom(ws) {
    const roomId = ws.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(ws);

    // notify remaining peer
    for (const peer of room) {
      peer.send(
        JSON.stringify({
          type: "peer-left",
          roomId,
        })
      );
    }

    if (room.size === 0) {
      rooms.delete(roomId);
    }

    ws.roomId = null;
  }

  wss.on("connection", (ws) => {
    logger.info("[WebRTC] client connected");

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || !msg.type) return;

      if (msg.type === "join") {
        const { roomId } = msg;
        if (!roomId || typeof roomId !== "string") {
          ws.send(JSON.stringify({ type: "error", message: "Invalid roomId" }));
          return;
        }
        joinRoom(ws, roomId);
        return;
      }

      if (msg.type === "leave") {
        leaveRoom(ws);
        return;
      }

      if (msg.type === "signal") {
        const roomId = ws.roomId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;

        // forward signaling data to the other peer
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(
              JSON.stringify({
                type: "signal",
                signalType: msg.signalType,
                data: msg.data,
              })
            );
          }
        }
      }
    });

    ws.on("close", () => {
      leaveRoom(ws);
    });

    ws.on("error", (err) => {
      logger.error({ err }, "[WebRTC] ws error");
      leaveRoom(ws);
    });
  });

  logger.info("[WebRTC] signaling server mounted at /ws/prep");
}
