import test from "node:test";
import assert from "node:assert/strict";
import {
  getMetricsSnapshot,
  recordHttpRequestEnd,
  recordHttpRequestStart,
  resetMetricsForTests,
  toPrometheusMetrics,
} from "../../src/observability/metrics.js";

test("metrics snapshot aggregates totals and rolling window", () => {
  resetMetricsForTests();
  const now = Date.now();

  recordHttpRequestStart();
  recordHttpRequestEnd({
    method: "GET",
    route: "/health",
    statusCode: 200,
    durationMs: 80,
    observedAtMs: now - 1000,
  });

  recordHttpRequestStart();
  recordHttpRequestEnd({
    method: "GET",
    route: "/api/packages/123",
    statusCode: 500,
    durationMs: 900,
    observedAtMs: now - 500,
  });

  const snapshot = getMetricsSnapshot({ windowMs: 10_000 });

  assert.equal(snapshot.totals.requests, 2);
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.window.requests, 2);
  assert.equal(snapshot.window.failed, 1);
  assert.equal(snapshot.window.errorRatePct, 50);
  assert.equal(snapshot.window.p95Ms, 900);
  assert.equal(snapshot.byStatus["200"], 1);
  assert.equal(snapshot.byStatus["500"], 1);
});

test("prometheus output includes key series", () => {
  resetMetricsForTests();
  recordHttpRequestStart();
  recordHttpRequestEnd({
    method: "GET",
    route: "/api/message",
    statusCode: 200,
    durationMs: 40,
    observedAtMs: Date.now(),
  });

  const text = toPrometheusMetrics();

  assert.match(text, /speexify_http_inflight_requests/);
  assert.match(text, /speexify_http_requests_total\{method="GET",route="\/api\/message",status="200"\}/);
  assert.match(text, /speexify_http_request_duration_ms_count 1/);
});
