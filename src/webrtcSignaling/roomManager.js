// src/webrtcSignaling/roomManager.js

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { logger } from "../lib/logger.js";
import { MSG_TYPES } from "./config.js";
import { getMeta } from "./socketMeta.js";
import { validateRoomId } from "./validation.js";
import { safeSend } from "./transport.js";
import { acquireRoom, releaseRoom, touchRoom } from "../services/distributedState.js";

function createRoomManager(options) {
  const {
    name,
    channelName = name,
    maxPeers,
    maxRooms,
    roomIdKey,
    notifyOnJoin = true,
    notifyOnLeave = true,
    trackInitiator = false,
    roomLeaseMs = 90_000,
    publishRoomEvent = null,
  } = options;

  const rooms = new Map();
  const roomLocks = new Map();

  async function withRoomLock(roomId, callback) {
    const previous = roomLocks.get(roomId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    roomLocks.set(roomId, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (roomLocks.get(roomId) === current) roomLocks.delete(roomId);
    }
  }

  function getConnectionId(ws) {
    const meta = getMeta(ws);
    if (!meta.connectionId) meta.connectionId = randomUUID();
    return meta.connectionId;
  }

  function publish(event) {
    if (typeof publishRoomEvent === "function") {
      publishRoomEvent({ channel: channelName, ...event });
    }
  }

  async function join(ws, roomId) {
    const meta = getMeta(ws);
    const roomValidation = validateRoomId(roomId);
    if (!roomValidation.valid) {
      safeSend(ws, { type: MSG_TYPES.ERROR, message: roomValidation.reason });
      return false;
    }

    return withRoomLock(roomId, async () => {
      if (!rooms.has(roomId) && rooms.size >= maxRooms) {
        safeSend(ws, { type: MSG_TYPES.ERROR, message: "Maximum room limit reached" });
        return false;
      }

      if (meta[roomIdKey] && meta[roomIdKey] !== roomId) {
        await leave(ws);
      }

      let room = rooms.get(roomId);
      if (!room) {
        room = new Set();
        rooms.set(roomId, room);
      }
      for (const peer of Array.from(room)) {
        if (peer.readyState !== WebSocket.OPEN) room.delete(peer);
      }
      if (room.has(ws)) return true;
      if (room.size >= maxPeers) {
        safeSend(ws, { type: MSG_TYPES.ROOM_FULL });
        return false;
      }

      const admission = await acquireRoom({
        channel: channelName,
        roomId,
        connectionId: getConnectionId(ws),
        maxPeers,
        maxRooms,
        leaseMs: roomLeaseMs,
      });
      if (!admission.allowed) {
        if (room.size === 0) rooms.delete(roomId);
        safeSend(ws, {
          type: admission.reason === "full" ? MSG_TYPES.ROOM_FULL : MSG_TYPES.ERROR,
          ...(admission.reason === "full"
            ? {}
            : {
                message:
                  admission.reason === "rooms"
                    ? "Maximum room limit reached"
                    : "Shared room capacity is temporarily unavailable",
              }),
        });
        return false;
      }

      room.add(ws);
      meta[roomIdKey] = roomId;
      const isInitiator = trackInitiator ? room.size === 1 : false;
      if (trackInitiator) meta.isInitiator = isInitiator;

      safeSend(ws, { type: MSG_TYPES.JOINED, roomId, isInitiator });
      if (notifyOnJoin) {
        for (const peer of room) {
          if (peer.readyState === WebSocket.OPEN) safeSend(peer, { type: MSG_TYPES.PEER_JOINED, roomId });
        }
      }
      publish({ eventType: "peer-joined", roomId });
      logger.info({ roomId, size: room.size }, `[${name}] join room`);
      return true;
    });
  }

  async function leave(ws) {
    const meta = getMeta(ws);
    const roomId = meta[roomIdKey];
    if (!roomId) return;
    meta[roomIdKey] = null;
    const room = rooms.get(roomId);
    if (!room) {
      await releaseRoom({ channel: channelName, roomId, connectionId: getConnectionId(ws) });
      return;
    }
    if (!room.delete(ws)) return;

    if (notifyOnLeave) {
      for (const peer of room) {
        if (peer.readyState === WebSocket.OPEN) safeSend(peer, { type: MSG_TYPES.PEER_LEFT, roomId });
      }
    }
    await releaseRoom({ channel: channelName, roomId, connectionId: getConnectionId(ws) });
    const remainingSize = room.size;
    if (remainingSize === 0) rooms.delete(roomId);
    publish({ eventType: "peer-left", roomId });
    logger.info({ roomId, size: remainingSize }, `[${name}] leave room`);
  }

  function broadcastRoom(roomId, message, excludedWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const payload = JSON.stringify(message);
    for (const peer of room) {
      if (peer !== excludedWs && peer.readyState === WebSocket.OPEN) {
        try { peer.send(payload); } catch (err) { logger.warn({ err }, "[WebRTC] Failed to send message"); }
      }
    }
  }

  function broadcast(ws, message) {
    const roomId = getMeta(ws)[roomIdKey];
    if (!roomId) return;
    broadcastRoom(roomId, message, ws);
    publish({ eventType: "message", roomId, message, senderConnectionId: getConnectionId(ws) });
  }

  async function touch(ws) {
    const meta = getMeta(ws);
    const roomId = meta[roomIdKey];
    if (!roomId) return;
    await touchRoom({ channel: channelName, roomId, connectionId: getConnectionId(ws), leaseMs: roomLeaseMs });
  }

  function handleRemoteEvent(event) {
    if (!event || event.channel !== channelName || !event.roomId) return;
    if (event.eventType === "message") {
      broadcastRoom(event.roomId, event.message);
    } else if (event.eventType === "peer-joined" && notifyOnJoin) {
      broadcastRoom(event.roomId, { type: MSG_TYPES.PEER_JOINED, roomId: event.roomId });
    } else if (event.eventType === "peer-left" && notifyOnLeave) {
      broadcastRoom(event.roomId, { type: MSG_TYPES.PEER_LEFT, roomId: event.roomId });
    }
  }

  function getRoom(ws) {
    const roomId = getMeta(ws)[roomIdKey];
    if (!roomId) return null;
    return rooms.get(roomId) || null;
  }
  function getRoomId(ws) { return getMeta(ws)[roomIdKey]; }
  function getRoomCount() { return rooms.size; }
  function getAllSockets() {
    const allSockets = new Set();
    for (const room of rooms.values()) for (const ws of room) allSockets.add(ws);
    return allSockets;
  }

  return { join, leave, touch, broadcast, broadcastRoom, handleRemoteEvent, getRoom, getRoomId, getRoomCount, getAllSockets, rooms };
}

export { createRoomManager };
