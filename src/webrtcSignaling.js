// src/webrtcSignaling.js
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./lib/logger.js";

/**
 * Attach WebSocket servers to the existing HTTP server.
 *
 * /ws/prep       → WebRTC signaling (video, screen share)
 * /ws/classroom  → Classroom events (resource sync, annotations, etc.)
 */
export function setupWebRtcSignaling(httpServer) {
  // ─────────────────────────────────────────────────────────────
  // 1) WebRTC signaling: /ws/prep (max 2 peers per room)
  // ─────────────────────────────────────────────────────────────
  const wssPrep = new WebSocketServer({
    server: httpServer,
    path: "/ws/prep",
  });

  const prepRooms = new Map(); // roomId -> Set<WebSocket>

  function joinPrepRoom(ws, roomId) {
    let room = prepRooms.get(roomId);
    if (!room) {
      room = new Set();
      prepRooms.set(roomId, room);
    }

    if (room.size >= 2) {
      ws.send(JSON.stringify({ type: "room-full" }));
      ws.close();
      return;
    }

    room.add(ws);
    ws.prepRoomId = roomId;

    const isInitiator = room.size === 1;
    ws.isInitiator = isInitiator;

    ws.send(
      JSON.stringify({
        type: "joined",
        roomId,
        isInitiator,
      })
    );

    // Notify everyone that someone joined:
    for (const peer of room) {
      if (peer.readyState === peer.OPEN) {
        peer.send(
          JSON.stringify({
            type: "peer-joined",
            roomId,
          })
        );
      }
    }
  }

  function leavePrepRoom(ws) {
    const roomId = ws.prepRoomId;
    if (!roomId) return;
    const room = prepRooms.get(roomId);
    if (!room) return;

    room.delete(ws);

    // notify remaining peer
    for (const peer of room) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(
          JSON.stringify({
            type: "peer-left",
            roomId,
          })
        );
      }
    }

    if (room.size === 0) {
      prepRooms.delete(roomId);
    }

    ws.prepRoomId = null;
  }

  wssPrep.on("connection", (ws) => {
    logger.info("[WebRTC] client connected to /ws/prep");

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
        joinPrepRoom(ws, roomId);
        return;
      }

      if (msg.type === "leave") {
        leavePrepRoom(ws);
        return;
      }

      if (msg.type === "signal") {
        const roomId = ws.prepRoomId;
        if (!roomId) return;
        const room = prepRooms.get(roomId);
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
      leavePrepRoom(ws);
    });

    ws.on("error", (err) => {
      logger.error({ err }, "[WebRTC] ws error (/ws/prep)");
      leavePrepRoom(ws);
    });
  });

  logger.info("[WebRTC] signaling server mounted at /ws/prep");

  // ─────────────────────────────────────────────────────────────
  // 2) Classroom channel: /ws/classroom
  //    Same roomId model, separate from WebRTC sockets.
  // ─────────────────────────────────────────────────────────────
  const wssClassroom = new WebSocketServer({
    server: httpServer,
    path: "/ws/classroom",
  });

  const classroomRooms = new Map(); // roomId -> Set<WebSocket>

  function joinClassroomRoom(ws, roomId) {
    let room = classroomRooms.get(roomId);
    if (!room) {
      room = new Set();
      classroomRooms.set(roomId, room);
    }

    room.add(ws);
    ws.classroomRoomId = roomId;

    // We don't send joined/peer-joined here unless you need them.
  }

  function leaveClassroomRoom(ws) {
    const roomId = ws.classroomRoomId;
    if (!roomId) return;
    const room = classroomRooms.get(roomId);
    if (!room) return;

    room.delete(ws);
    if (room.size === 0) {
      classroomRooms.delete(roomId);
    }
    ws.classroomRoomId = null;
  }

  wssClassroom.on("connection", (ws) => {
    logger.info("[Classroom] client connected to /ws/classroom");

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
        joinClassroomRoom(ws, roomId);
        return;
      }

      if (msg.type === "leave") {
        leaveClassroomRoom(ws);
        return;
      }

      if (msg.type === "signal") {
        const roomId = ws.classroomRoomId;
        if (!roomId) return;
        const room = classroomRooms.get(roomId);
        if (!room) return;

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
      leaveClassroomRoom(ws);
    });

    ws.on("error", (err) => {
      logger.error({ err }, "[Classroom] ws error (/ws/classroom)");
      leaveClassroomRoom(ws);
    });
  });

  logger.info("[Classroom] signaling server mounted at /ws/classroom");
}
