import test from "node:test";
import assert from "node:assert/strict";
import {
  getMetricsSnapshot,
  recordPayrollReconciliation,
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

test("payroll reconciliation is exposed in JSON and Prometheus metrics", () => {
  resetMetricsForTests();
  recordPayrollReconciliation({
    available: true,
    completedSessions: 10,
    earningRows: 9,
    missingEarnings: 1,
    coveragePct: 90,
    pendingSnapshotJobs: 1,
    failedSnapshotJobs: 0,
    processingSnapshotJobs: 0,
  });

  const snapshot = getMetricsSnapshot();
  const text = toPrometheusMetrics();

  assert.equal(snapshot.payroll.missingEarnings, 1);
  assert.equal(snapshot.payroll.coveragePct, 90);
  assert.match(text, /speexify_payroll_completed_sessions 10/);
  assert.match(text, /speexify_payroll_missing_earnings 1/);
  assert.match(text, /speexify_payroll_snapshot_jobs_pending 1/);
});
