import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalRateLimiter,
  createSerialQueue,
} from "../../src/webrtcSignaling/messageFlow.js";

test("messages from one socket are handled in arrival order even when slow", async () => {
  const order = [];
  const queue = createSerialQueue();
  // A slow "join" (database authorisation) followed by a fast event.
  queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("join");
  });
  queue.run(async () => {
    order.push("REQUEST_RESOURCE");
  });
  await queue.idle();
  assert.deepEqual(order, ["join", "REQUEST_RESOURCE"]);
  assert.equal(queue.pending, 0);
});

test("a failing message does not block the next one", async () => {
  const errors = [];
  const handled = [];
  const queue = createSerialQueue({ onError: (err) => errors.push(err.message) });
  queue.run(async () => {
    throw new Error("boom");
  });
  queue.run(async () => handled.push("next"));
  await queue.idle();
  assert.deepEqual(errors, ["boom"]);
  assert.deepEqual(handled, ["next"]);
});

test("the queue refuses work beyond its bound", async () => {
  const queue = createSerialQueue({ maxPending: 2 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  assert.equal(queue.run(() => gate), true);
  assert.equal(queue.run(() => null), true);
  assert.equal(queue.run(() => null), false);
  release();
  await queue.idle();
  assert.equal(queue.run(() => null), true);
});

test("the local limiter allows `limit` messages per window", () => {
  let clock = 1000;
  const limiter = createLocalRateLimiter({ limit: 3, windowMs: 1000, now: () => clock });
  assert.equal(limiter.consume(), true);
  assert.equal(limiter.consume(), true);
  assert.equal(limiter.consume(), true);
  assert.equal(limiter.consume(), false);
  clock += 999;
  assert.equal(limiter.consume(), false);
  clock += 1;
  assert.equal(limiter.consume(), true);
});
