// src/webrtcSignaling/socketMeta.js

const socketMeta = new WeakMap();

function getMeta(ws) {
  let meta = socketMeta.get(ws);
  if (!meta) {
    meta = {
      videoRoomId: null,
      classroomRoomId: null,
      isInitiator: false,
      userId: null,
      ip: null,
      isAlive: true,
      messageTimestamps: [],
    };
    socketMeta.set(ws, meta);
  }
  return meta;
}

export { getMeta };
