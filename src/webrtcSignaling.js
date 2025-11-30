// src/webrtcSignaling.js
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./lib/logger.js";

/**
 * Attach WebSocket servers to the existing HTTP server.
 *
 * We use the "noServer" pattern and handle the HTTP upgrade manually so that
 * proxies (like Render) can't interfere with the path matching.
 */
export function setupWebRtcSignaling(httpServer) {
  // ─────────────────────────────────────────────
  // Create two WS servers (noServer = true)
  // ─────────────────────────────────────────────
  const wssPrep = new WebSocketServer({ noServer: true });
  const wssClassroom = new WebSocketServer({ noServer: true });

  // ─────────────────────────────────────────────
  // 1) WebRTC signaling (/ws/prep) – 1:1 video
  // ─────────────────────────────────────────────
  const videoRooms = new Map(); // roomId -> Set<WebSocket>
  const MAX_VIDEO_PEERS = 2;

  function joinVideoRoom(ws, roomId) {
    let room = videoRooms.get(roomId);
    if (!room) {
      room = new Set();
      videoRooms.set(roomId, room);
    }

    // 🔹 If this socket was already in another room, leave it first
    if (ws.videoRoomId && ws.videoRoomId !== roomId) {
      leaveVideoRoom(ws);
    }

    // 🔹 Remove any dead sockets that never got cleaned up
    for (const peer of Array.from(room)) {
      if (peer.readyState !== WebSocket.OPEN) {
        room.delete(peer);
      }
    }

    // If this exact socket is already in the room, nothing to do
    if (room.has(ws)) {
      return;
    }

    // 🔹 Enforce max peers AFTER pruning dead connections
    if (room.size >= MAX_VIDEO_PEERS) {
      ws.send(JSON.stringify({ type: "room-full" }));
      // NOTE: do NOT close the socket here – let the client decide.
      // ws.close();
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

    // notify everyone someone joined (including this peer, as before)
    for (const peer of room) {
      if (peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(
            JSON.stringify({
              type: "peer-joined",
              roomId,
            })
          );
        } catch (err) {
          logger.warn({ err }, "[WebRTC] failed to send peer-joined");
        }
      }
    }

    logger.info({ roomId, size: room.size }, "[WebRTC] join /ws/prep room");
  }

  function leaveVideoRoom(ws) {
    const roomId = ws.videoRoomId;
    if (!roomId) return;

    const room = videoRooms.get(roomId);
    if (!room) {
      ws.videoRoomId = null;
      return;
    }

    if (room.has(ws)) {
      room.delete(ws);
    }

    // notify remaining peer(s)
    for (const peer of room) {
      if (peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(
            JSON.stringify({
              type: "peer-left",
              roomId,
            })
          );
        } catch (err) {
          logger.warn({ err }, "[WebRTC] failed to send peer-left");
        }
      }
    }

    if (room.size === 0) {
      videoRooms.delete(roomId);
    }

    ws.videoRoomId = null;

    logger.info({ roomId, size: room.size }, "[WebRTC] leave /ws/prep room");
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

        // forward offer/answer/candidate to the other peer
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            try {
              peer.send(
                JSON.stringify({
                  type: "signal",
                  signalType: msg.signalType,
                  data: msg.data,
                })
              );
            } catch (err) {
              logger.warn(
                { err },
                "[WebRTC] failed to forward signal (/ws/prep)"
              );
            }
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

  // ─────────────────────────────────────────────
  // 2) Classroom channel (/ws/classroom)
  // ─────────────────────────────────────────────
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
    if (!room) {
      ws.classroomRoomId = null;
      return;
    }

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

        // forward classroom events to all other peers
        for (const peer of room) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            try {
              peer.send(
                JSON.stringify({
                  type: "signal",
                  signalType: msg.signalType,
                  data: msg.data,
                })
              );
            } catch (err) {
              logger.warn(
                { err },
                "[Classroom] failed to forward signal (/ws/classroom)"
              );
            }
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

  // ─────────────────────────────────────────────
  // 3) Manual HTTP upgrade routing
  // ─────────────────────────────────────────────
  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "/";
    try {
      const url = new URL(request.url || "", "http://localhost");
      pathname = url.pathname || "/";
    } catch {
      // ignore and close
    }

    if (pathname === "/ws/prep") {
      wssPrep.handleUpgrade(request, socket, head, (ws) => {
        wssPrep.emit("connection", ws, request);
      });
    } else if (pathname === "/ws/classroom") {
      wssClassroom.handleUpgrade(request, socket, head, (ws) => {
        wssClassroom.emit("connection", ws, request);
      });
    } else {
      // Not one of our WS paths
      socket.destroy();
    }
  });

  logger.info("[WebRTC] signaling server ready at /ws/prep");
  logger.info("[Classroom] signaling server ready at /ws/classroom");
}
