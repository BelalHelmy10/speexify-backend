import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  validateRoomId,
  validateSignalPayload,
} from "../../src/webrtcSignaling/validation.js";
import { CONFIG } from "../../src/webrtcSignaling/config.js";

test("validateRoomId accepts safe IDs and rejects invalid values", () => {
  assert.deepEqual(validateRoomId("room_123-ABC"), { valid: true });
  assert.equal(validateRoomId("bad room id").valid, false);
  assert.equal(validateRoomId("").valid, false);
  assert.equal(validateRoomId(null).valid, false);
});

test("validateSignalPayload enforces presence and max size of data", () => {
  const missing = validateSignalPayload({ signalType: "offer" });
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /Missing signal data/);

  const oversized = validateSignalPayload({
    signalType: "offer",
    data: "x".repeat(CONFIG.MAX_SIGNAL_DATA_SIZE + 1),
  });
  assert.equal(oversized.valid, false);
  assert.match(oversized.reason, /Signal data too large/);

  assert.deepEqual(
    validateSignalPayload({ signalType: "offer", data: { sdp: "ok" } }),
    { valid: true }
  );
});

test("checkRateLimit blocks after max messages in a window", () => {
  const ws = {};

  for (let i = 0; i < CONFIG.RATE_LIMIT_MAX_MESSAGES; i += 1) {
    assert.equal(checkRateLimit(ws), true);
  }

  assert.equal(checkRateLimit(ws), false);
});
