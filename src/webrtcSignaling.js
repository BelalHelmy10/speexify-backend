// src/webrtcSignaling.js
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./lib/logger.js";

/**
 * Attach WebSocket servers to the existing HTTP server.
 *
 * /ws/prep       → WebRTC signaling (video)
 * /ws/classroom  → Classroom events (resource sync, annotations, etc.)
 */
export function setupWebRtcSignaling(httpServer) {
  // ─────────────────────────────────────────────
  // 1) WebRTC signaling (/ws/prep) – 1:1 video
  // ─────────────────────────────────────────────
  const wssPrep = new WebSocketServer({
    server: httpServer,
    path: "/ws/prep",
  });

  // roomId -> Set<WebSocket>
  const videoRooms = new Map();
  const MAX_VIDEO_PEERS = 2; // strictly 1:1

  function joinVideoRoom(ws, roomId) {
    let room = videoRooms.get(roomId);
    if (!room) {
      room = new Set();
      videoRooms.set(roomId, room);
    }

    if (room.size >= MAX_VIDEO_PEERS) {
      ws.send(JSON.stringify({ type: "room-full" }));
      ws.close();
      return;
    }

    room.add(ws);
    ws.videoRoomId = roomId;

    const isInitiator = room.size === 1;
    ws.isInitiator = isInitiator;

    ws.send(
      JSON.stringify({
        type: "joined",
        roomId,
        isInitiator,
      })
    );

    // Notify everyone that someone joined (for "peer-joined" in PrepVideoCall)
    for (const peer of room) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(
          JSON.stringify({
            type: "peer-joined",
            roomId,
          })
        );
      }
    }
  }

  function leaveVideoRoom(ws) {
    const roomId = ws.videoRoomId;
    if (!roomId) return;
    const room = videoRooms.get(roomId);
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
      videoRooms.delete(roomId);
    }

    ws.videoRoomId = null;
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
        joinVideoRoom(ws, roomId);
        return;
      }

      if (msg.type === "leave") {
        leaveVideoRoom(ws);
        return;
      }

      if (msg.type === "signal") {
        const roomId = ws.videoRoomId;
        if (!roomId) return;
        const room = videoRooms.get(roomId);
        if (!room) return;

        // forward signaling data (offer/answer/candidate) to the other peer
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
      leaveVideoRoom(ws);
    });

    ws.on("error", (err) => {
      logger.error({ err }, "[WebRTC] ws error (/ws/prep)");
      leaveVideoRoom(ws);
    });
  });

  logger.info("[WebRTC] signaling server mounted at /ws/prep");

  // ─────────────────────────────────────────────
  // 2) Classroom channel (/ws/classroom)
  //    – resource sync, annotations, etc.
  // ─────────────────────────────────────────────
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

        // forward classroom events to all other peers in the room
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
