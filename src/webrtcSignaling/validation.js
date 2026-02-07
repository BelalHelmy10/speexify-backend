// src/webrtcSignaling/validation.js

import { CONFIG } from "./config.js";
import { getMeta } from "./socketMeta.js";

function checkRateLimit(ws) {
  if (!CONFIG.RATE_LIMIT_ENABLED) return true;

  const meta = getMeta(ws);
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;

  meta.messageTimestamps = meta.messageTimestamps.filter((t) => t > windowStart);

  if (meta.messageTimestamps.length >= CONFIG.RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }

  meta.messageTimestamps.push(now);
  return true;
}

function validateRoomId(roomId) {
  if (!roomId || typeof roomId !== "string") {
    return { valid: false, reason: "Invalid roomId" };
  }
  if (!CONFIG.ROOM_ID_REGEX.test(roomId)) {
    return {
      valid: false,
      reason: "RoomId contains invalid characters or is too long",
    };
  }
  return { valid: true };
}

function validateSignalPayload(msg) {
  if (
    CONFIG.VALID_SIGNAL_TYPES &&
    Array.isArray(CONFIG.VALID_SIGNAL_TYPES) &&
    CONFIG.VALID_SIGNAL_TYPES.length > 0
  ) {
    if (!msg.signalType || !CONFIG.VALID_SIGNAL_TYPES.includes(msg.signalType)) {
      return { valid: false, reason: "Invalid signal type" };
    }
  }

  if (msg.data === undefined || msg.data === null) {
    return { valid: false, reason: "Missing signal data" };
  }

  try {
    const dataStr =
      typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
    if (
      typeof CONFIG.MAX_SIGNAL_DATA_SIZE === "number" &&
      dataStr.length > CONFIG.MAX_SIGNAL_DATA_SIZE
    ) {
      return { valid: false, reason: "Signal data too large" };
    }
  } catch {
    return { valid: false, reason: "Invalid signal data format" };
  }

  return { valid: true };
}

export { checkRateLimit, validateRoomId, validateSignalPayload };
