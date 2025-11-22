// src/webrtcSignaling.js
import { WebSocketServer } from "ws";

const rooms = new Map(); // roomId -> Set<ws>

/**
 * Attach WebRTC signaling WebSocket server to an existing HTTP server.
 * We’ll use path: /ws/prep
 */
export function attachWebRtcSignaling(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    // only handle /ws/prep upgrades
    if (!req.url.startsWith("/ws/prep")) {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    // custom metadata on the socket
    ws._roomId = null;

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.warn("[webrtc] invalid message", err);
        return;
      }

      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "join":
          handleJoin(ws, msg);
          break;
        case "signal":
          handleSignal(ws, msg);
          break;
        case "leave":
          handleLeave(ws);
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      handleLeave(ws);
    });
  });

  console.log("[webrtc] signaling server attached on /ws/prep");
}

function handleJoin(ws, msg) {
  const roomId = String(msg.roomId || "").trim();
  if (!roomId) return;

  // Attach roomId to this socket
  ws._roomId = roomId;

  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  // Limit to 2 participants for now (teacher + learner)
  if (room.size >= 2) {
    ws.send(JSON.stringify({ type: "room-full" }));
    ws.close();
    return;
  }

  room.add(ws);

  const clientsInRoom = room.size;
  const isInitiator = clientsInRoom === 2; // second person becomes initiator

  ws.send(
    JSON.stringify({
      type: "joined",
      roomId,
      isInitiator,
    })
  );

  // Notify the other peer someone joined (for UI / connection state)
  broadcastInRoom(roomId, ws, {
    type: "peer-joined",
    roomId,
  });

  console.log(
    `[webrtc] client joined room ${roomId} (size=${clientsInRoom}, initiator=${isInitiator})`
  );
}

function handleSignal(ws, msg) {
  const roomId = ws._roomId;
  if (!roomId) return;

  // Forward offer/answer/candidate to the *other* peer in the room
  const payload = {
    type: "signal",
    signalType: msg.signalType,
    data: msg.data,
  };

  broadcastInRoom(roomId, ws, payload);
}

function handleLeave(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(ws);
  ws._roomId = null;

  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    // tell remaining peer the other left
    broadcastInRoom(roomId, ws, { type: "peer-left", roomId });
  }

  console.log(`[webrtc] client left room ${roomId} (now ${room.size} clients)`);
}

function broadcastInRoom(roomId, senderWs, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  const str = JSON.stringify(msg);
  for (const client of room) {
    if (client !== senderWs && client.readyState === client.OPEN) {
      client.send(str);
    }
  }
}
