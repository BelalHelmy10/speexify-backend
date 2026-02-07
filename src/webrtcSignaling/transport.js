// src/webrtcSignaling/transport.js

import { WebSocket } from "ws";
import { logger } from "../lib/logger.js";

function safeSend(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    ws.send(payload);
    return true;
  } catch (err) {
    logger.warn({ err }, "[WebRTC] Failed to send message");
    return false;
  }
}

export { safeSend };
