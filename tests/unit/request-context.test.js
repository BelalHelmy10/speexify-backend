import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../../src/observability/requestContext.js";

test("buildRequestContext honors incoming request and trace IDs", () => {
  const req = {
    get(name) {
      const headers = {
        "x-request-id": "req-123",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
      };
      return headers[name.toLowerCase()] || headers[name] || "";
    },
  };

  const ctx = buildRequestContext(req);
  assert.equal(ctx.requestId, "req-123");
  assert.equal(ctx.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.match(ctx.spanId, /^[a-f0-9]{16}$/);
});

test("runWithRequestContext exposes context through async storage", async () => {
  const context = {
    requestId: "req-test",
    traceId: "trace-test",
    spanId: "span-test",
    startedAt: Date.now(),
  };

  await new Promise((resolve) => {
    runWithRequestContext(context, () => {
      setTimeout(() => {
        const current = getRequestContext();
        assert.equal(current?.requestId, "req-test");
        assert.equal(current?.traceId, "trace-test");
        resolve();
      }, 5);
    });
  });
});
