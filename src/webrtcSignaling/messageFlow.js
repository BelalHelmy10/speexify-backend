// src/webrtcSignaling/messageFlow.js
//
// Per-socket message flow control.
//
// - Messages from one socket are handled strictly in arrival order. The
//   handler is async (room-join authorisation hits the database), and running
//   messages concurrently meant events sent right after "join" were rejected
//   with "Not in a room" while the join was still being authorised.
// - Rate limiting is per socket and in-process (a fixed window). The previous
//   limiter made a Redis round-trip before every message, adding latency to
//   pointer/annotation traffic and dropping all messages when Redis was down.

export const MAX_PENDING_MESSAGES = 500;

/** Creates an in-order executor. `run(task)` returns false when saturated. */
export function createSerialQueue({ maxPending = MAX_PENDING_MESSAGES, onError } = {}) {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    run(task) {
      if (pending >= maxPending) return false;
      pending += 1;
      tail = tail
        .then(() => task())
        .catch((err) => {
          onError?.(err);
        })
        .finally(() => {
          pending -= 1;
        });
      return true;
    },
    get pending() {
      return pending;
    },
    idle() {
      return tail;
    },
  };
}

/** Fixed-window counter: `consume()` is true while under `limit` per window. */
export function createLocalRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  let windowStart = now();
  let count = 0;
  return {
    consume() {
      const current = now();
      if (current - windowStart >= windowMs) {
        windowStart = current;
        count = 0;
      }
      if (count >= limit) return false;
      count += 1;
      return true;
    },
  };
}
