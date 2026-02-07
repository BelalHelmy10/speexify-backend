// src/webrtcSignaling/roomManager.js

import { WebSocket } from "ws";
import { logger } from "../lib/logger.js";
import { MSG_TYPES } from "./config.js";
import { getMeta } from "./socketMeta.js";
import { validateRoomId } from "./validation.js";
import { safeSend } from "./transport.js";

function createRoomManager(options) {
  const {
    name,
    maxPeers,
    maxRooms,
    roomIdKey,
    notifyOnJoin = true,
    notifyOnLeave = true,
    trackInitiator = false,
  } = options;

  const rooms = new Map();
  const roomLocks = new Map();

  function join(ws, roomId) {
    const meta = getMeta(ws);

    const roomValidation = validateRoomId(roomId);
    if (!roomValidation.valid) {
      safeSend(ws, { type: MSG_TYPES.ERROR, message: roomValidation.reason });
      return false;
    }

    if (!rooms.has(roomId) && rooms.size >= maxRooms) {
      safeSend(ws, {
        type: MSG_TYPES.ERROR,
        message: "Maximum room limit reached",
      });
      return false;
    }

    if (roomLocks.get(roomId)) {
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

      if (meta[roomIdKey] && meta[roomIdKey] !== roomId) {
        leave(ws);
      }

      for (const peer of Array.from(room)) {
        if (peer.readyState !== WebSocket.OPEN) {
          room.delete(peer);
        }
      }

      if (room.has(ws)) {
        roomLocks.set(roomId, false);
        return true;
      }

      if (room.size >= maxPeers) {
        safeSend(ws, { type: MSG_TYPES.ROOM_FULL });
        roomLocks.set(roomId, false);
        return false;
      }

      room.add(ws);
      meta[roomIdKey] = roomId;

      const isInitiator = trackInitiator ? room.size === 1 : false;
      if (trackInitiator) {
        meta.isInitiator = isInitiator;
      }

      safeSend(ws, {
        type: MSG_TYPES.JOINED,
        roomId,
        isInitiator,
      });

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

    const payload = JSON.stringify(message);
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
    rooms,
  };
}

export { createRoomManager };
