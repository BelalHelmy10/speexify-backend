const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10000];
const MAX_RECENT_WINDOW_MS = 15 * 60 * 1000;

const BUSINESS_METRIC_FIELDS = Object.freeze({
  pricingCatalog: ["requests", "successes", "failures", "latencySumMs"],
  cms: ["queries", "successes", "failures", "slowQueries", "latencySumMs"],
  email: ["queued", "queueFailures", "sent", "failed", "bounced", "complained", "suppressed"],
  paymentWebhooks: ["received", "processed", "failed", "unreconciled"],
  auth: ["transientFailures", "unauthorized", "authenticated"],
});

function createBusinessState() {
  return Object.fromEntries(
    Object.entries(BUSINESS_METRIC_FIELDS).map(([group, fields]) => [
      group,
      Object.fromEntries(fields.map((field) => [field, 0])),
    ])
  );
}

function createState() {
  return {
    startedAtMs: Date.now(),
    inflight: 0,
    requestsTotal: 0,
    failedTotal: 0,
    durationSumMs: 0,
    durationMinMs: Number.POSITIVE_INFINITY,
    durationMaxMs: 0,
    byStatus: new Map(),
    byRoute: new Map(),
    byRouteStatus: new Map(),
    latencyBuckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
    recentEvents: [],
    recentBusinessEvents: [],
    business: createBusinessState(),
    payroll: {
      available: false,
      completedSessions: 0,
      earningRows: 0,
      missingEarnings: 0,
      coveragePct: 0,
      pendingSnapshotJobs: 0,
      failedSnapshotJobs: 0,
      processingSnapshotJobs: 0,
      observedAt: null,
    },
  };
}

const state = createState();

function escapePromLabel(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function normalizeRouteLabel(route) {
  const path = String(route || "unknown")
    .split("?")[0]
    .replace(/\/+/g, "/")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[a-f0-9-]{16,}(?=\/|$)/gi, "/:id");

  return path || "unknown";
}

function updateLatencyBuckets(durationMs) {
  let bucketIndex = LATENCY_BUCKETS_MS.length;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    if (durationMs <= LATENCY_BUCKETS_MS[i]) {
      bucketIndex = i;
      break;
    }
  }
  state.latencyBuckets[bucketIndex] += 1;
}

function pruneRecent(nowMs) {
  const cutoff = nowMs - MAX_RECENT_WINDOW_MS;
  while (state.recentEvents.length > 0 && state.recentEvents[0].ts < cutoff) {
    state.recentEvents.shift();
  }
  while (
    state.recentBusinessEvents.length > 0 &&
    state.recentBusinessEvents[0].ts < cutoff
  ) {
    state.recentBusinessEvents.shift();
  }
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const idx = Math.ceil(sortedValues.length * q) - 1;
  const boundedIndex = Math.max(0, Math.min(sortedValues.length - 1, idx));
  return sortedValues[boundedIndex];
}

export function recordHttpRequestStart() {
  state.inflight += 1;
}

export function recordHttpRequestEnd({
  method,
  route,
  statusCode,
  durationMs,
  observedAtMs = Date.now(),
}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedRoute = normalizeRouteLabel(route);
  const normalizedStatus = Number.isInteger(statusCode) ? statusCode : 0;
  const normalizedDuration = Math.max(0, Number(durationMs) || 0);

  state.inflight = Math.max(0, state.inflight - 1);
  state.requestsTotal += 1;
  if (normalizedStatus >= 500 || normalizedStatus === 0) {
    state.failedTotal += 1;
  }

  state.durationSumMs += normalizedDuration;
  state.durationMinMs = Math.min(state.durationMinMs, normalizedDuration);
  state.durationMaxMs = Math.max(state.durationMaxMs, normalizedDuration);
  updateLatencyBuckets(normalizedDuration);

  const statusKey = String(normalizedStatus);
  state.byStatus.set(statusKey, (state.byStatus.get(statusKey) || 0) + 1);

  const routeKey = `${normalizedMethod} ${normalizedRoute}`;
  const routeAgg = state.byRoute.get(routeKey) || {
    method: normalizedMethod,
    route: normalizedRoute,
    count: 0,
    failed: 0,
    durationSumMs: 0,
    durationMaxMs: 0,
  };
  routeAgg.count += 1;
  if (normalizedStatus >= 500 || normalizedStatus === 0) {
    routeAgg.failed += 1;
  }
  routeAgg.durationSumMs += normalizedDuration;
  routeAgg.durationMaxMs = Math.max(routeAgg.durationMaxMs, normalizedDuration);
  state.byRoute.set(routeKey, routeAgg);

  const routeStatusKey = `${normalizedMethod}|${normalizedRoute}|${normalizedStatus}`;
  state.byRouteStatus.set(
    routeStatusKey,
    (state.byRouteStatus.get(routeStatusKey) || 0) + 1
  );

  state.recentEvents.push({
    ts: observedAtMs,
    statusCode: normalizedStatus,
    durationMs: normalizedDuration,
  });
  if (
    normalizedRoute === "/api/auth/me" &&
    (normalizedStatus >= 500 || normalizedStatus === 499 || normalizedStatus === 0)
  ) {
    recordBusinessMetric("auth", "transientFailures");
  }
  pruneRecent(observedAtMs);
}

export function recordBusinessMetric(
  group,
  field,
  { count = 1, durationMs = null, observedAtMs = Date.now() } = {}
) {
  const metricGroup = state.business[group];
  if (!metricGroup || !Object.prototype.hasOwnProperty.call(metricGroup, field)) {
    return;
  }

  const normalizedCount = Math.max(0, Number(count) || 0);
  metricGroup[field] += normalizedCount;
  if (durationMs != null && Object.prototype.hasOwnProperty.call(metricGroup, "latencySumMs")) {
    metricGroup.latencySumMs += Math.max(0, Number(durationMs) || 0);
  }

  state.recentBusinessEvents.push({
    ts: observedAtMs,
    group,
    field,
    count: normalizedCount,
    durationMs: durationMs == null ? null : Math.max(0, Number(durationMs) || 0),
  });
  pruneRecent(observedAtMs);
}

export function recordPayrollReconciliation(snapshot = {}) {
  state.payroll = {
    available: snapshot.available === true,
    completedSessions: Math.max(0, Number(snapshot.completedSessions) || 0),
    earningRows: Math.max(0, Number(snapshot.earningRows) || 0),
    missingEarnings: Math.max(0, Number(snapshot.missingEarnings) || 0),
    coveragePct: Math.max(0, Number(snapshot.coveragePct) || 0),
    pendingSnapshotJobs: Math.max(0, Number(snapshot.pendingSnapshotJobs) || 0),
    failedSnapshotJobs: Math.max(0, Number(snapshot.failedSnapshotJobs) || 0),
    processingSnapshotJobs: Math.max(0, Number(snapshot.processingSnapshotJobs) || 0),
    observedAt: snapshot.observedAt || new Date().toISOString(),
  };
}

export function getMetricsSnapshot({ windowMs = 5 * 60 * 1000 } = {}) {
  const nowMs = Date.now();
  pruneRecent(nowMs);

  const validWindowMs = Number.isFinite(Number(windowMs))
    ? Math.max(1000, Math.floor(Number(windowMs)))
    : 5 * 60 * 1000;
  const cutoff = nowMs - validWindowMs;
  const windowEvents = state.recentEvents.filter((event) => event.ts >= cutoff);
  const windowRequests = windowEvents.length;
  const windowFailures = windowEvents.filter(
    (event) => event.statusCode >= 500 || event.statusCode === 0
  ).length;
  const windowDurations = windowEvents
    .map((event) => event.durationMs)
    .sort((a, b) => a - b);

  const windowBusiness = createBusinessState();
  for (const event of state.recentBusinessEvents) {
    if (event.ts < cutoff || !windowBusiness[event.group]) continue;
    if (Object.prototype.hasOwnProperty.call(windowBusiness[event.group], event.field)) {
      windowBusiness[event.group][event.field] += event.count;
    }
    if (
      event.durationMs != null &&
      Object.prototype.hasOwnProperty.call(windowBusiness[event.group], "latencySumMs")
    ) {
      windowBusiness[event.group].latencySumMs += event.durationMs;
    }
  }

  const windowErrorRatePct =
    windowRequests > 0 ? (windowFailures / windowRequests) * 100 : 0;

  const uptimeSec = Math.max(1, Math.floor(process.uptime()));

  const topRoutes = Array.from(state.byRoute.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((item) => ({
      method: item.method,
      route: item.route,
      count: item.count,
      failed: item.failed,
      errorRatePct: item.count > 0 ? Number(((item.failed / item.count) * 100).toFixed(2)) : 0,
      avgMs: item.count > 0 ? Number((item.durationSumMs / item.count).toFixed(2)) : 0,
      maxMs: Number(item.durationMaxMs.toFixed(2)),
    }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    process: {
      uptimeSec,
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapTotalBytes: process.memoryUsage().heapTotal,
    },
    totals: {
      inflight: state.inflight,
      requests: state.requestsTotal,
      failed: state.failedTotal,
      availabilityPct:
        state.requestsTotal > 0
          ? Number((((state.requestsTotal - state.failedTotal) / state.requestsTotal) * 100).toFixed(2))
          : 100,
      avgMs:
        state.requestsTotal > 0
          ? Number((state.durationSumMs / state.requestsTotal).toFixed(2))
          : 0,
      minMs:
        state.durationMinMs === Number.POSITIVE_INFINITY
          ? 0
          : Number(state.durationMinMs.toFixed(2)),
      maxMs: Number(state.durationMaxMs.toFixed(2)),
    },
    window: {
      windowMs: validWindowMs,
      requests: windowRequests,
      failed: windowFailures,
      errorRatePct: Number(windowErrorRatePct.toFixed(2)),
      rps: Number((windowRequests / (validWindowMs / 1000)).toFixed(2)),
      p95Ms: Number(quantile(windowDurations, 0.95).toFixed(2)),
      p99Ms: Number(quantile(windowDurations, 0.99).toFixed(2)),
    },
    payroll: { ...state.payroll },
    business: {
      totals: Object.fromEntries(
        Object.entries(state.business).map(([group, values]) => [group, { ...values }])
      ),
      window: windowBusiness,
    },
    byStatus: Object.fromEntries(state.byStatus.entries()),
    topRoutes,
  };
}

export function toPrometheusMetrics() {
  const lines = [];
  const uptime = process.uptime();
  const mem = process.memoryUsage();

  lines.push("# HELP speexify_http_inflight_requests Current in-flight HTTP requests");
  lines.push("# TYPE speexify_http_inflight_requests gauge");
  lines.push(`speexify_http_inflight_requests ${state.inflight}`);

  lines.push("# HELP speexify_http_requests_total Total HTTP requests by method/route/status");
  lines.push("# TYPE speexify_http_requests_total counter");
  for (const [routeStatusKey, count] of state.byRouteStatus.entries()) {
    const [method, route, status] = routeStatusKey.split("|");
    lines.push(
      `speexify_http_requests_total{method="${escapePromLabel(
        method
      )}",route="${escapePromLabel(route)}",status="${escapePromLabel(status)}"} ${count}`
    );
  }

  lines.push(
    "# HELP speexify_http_request_duration_ms Request latency histogram in milliseconds"
  );
  lines.push("# TYPE speexify_http_request_duration_ms histogram");
  let cumulative = 0;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    cumulative += state.latencyBuckets[i];
    lines.push(
      `speexify_http_request_duration_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${cumulative}`
    );
  }
  cumulative += state.latencyBuckets[LATENCY_BUCKETS_MS.length];
  lines.push(`speexify_http_request_duration_ms_bucket{le="+Inf"} ${cumulative}`);
  lines.push(`speexify_http_request_duration_ms_sum ${state.durationSumMs.toFixed(2)}`);
  lines.push(`speexify_http_request_duration_ms_count ${state.requestsTotal}`);

  lines.push("# HELP speexify_process_uptime_seconds Process uptime in seconds");
  lines.push("# TYPE speexify_process_uptime_seconds gauge");
  lines.push(`speexify_process_uptime_seconds ${uptime.toFixed(2)}`);

  lines.push("# HELP speexify_process_resident_memory_bytes Process RSS in bytes");
  lines.push("# TYPE speexify_process_resident_memory_bytes gauge");
  lines.push(`speexify_process_resident_memory_bytes ${mem.rss}`);

  lines.push("# HELP speexify_process_heap_used_bytes Process heap used in bytes");
  lines.push("# TYPE speexify_process_heap_used_bytes gauge");
  lines.push(`speexify_process_heap_used_bytes ${mem.heapUsed}`);

  lines.push("# HELP speexify_payroll_completed_sessions Completed sessions assigned to teachers");
  lines.push("# TYPE speexify_payroll_completed_sessions gauge");
  lines.push(`speexify_payroll_completed_sessions ${state.payroll.completedSessions}`);
  lines.push("# HELP speexify_payroll_earning_rows Teacher earning rows for completed sessions");
  lines.push("# TYPE speexify_payroll_earning_rows gauge");
  lines.push(`speexify_payroll_earning_rows ${state.payroll.earningRows}`);
  lines.push("# HELP speexify_payroll_missing_earnings Completed sessions without earning rows");
  lines.push("# TYPE speexify_payroll_missing_earnings gauge");
  lines.push(`speexify_payroll_missing_earnings ${state.payroll.missingEarnings}`);
  lines.push("# HELP speexify_payroll_coverage_pct Completed sessions with earning rows");
  lines.push("# TYPE speexify_payroll_coverage_pct gauge");
  lines.push(`speexify_payroll_coverage_pct ${state.payroll.coveragePct}`);
  lines.push("# HELP speexify_payroll_snapshot_jobs_pending Pending earning snapshot jobs");
  lines.push("# TYPE speexify_payroll_snapshot_jobs_pending gauge");
  lines.push(`speexify_payroll_snapshot_jobs_pending ${state.payroll.pendingSnapshotJobs}`);
  lines.push("# HELP speexify_payroll_snapshot_jobs_failed Failed earning snapshot jobs");
  lines.push("# TYPE speexify_payroll_snapshot_jobs_failed gauge");
  lines.push(`speexify_payroll_snapshot_jobs_failed ${state.payroll.failedSnapshotJobs}`);
  lines.push("# HELP speexify_payroll_snapshot_jobs_processing Processing earning snapshot jobs");
  lines.push("# TYPE speexify_payroll_snapshot_jobs_processing gauge");
  lines.push(`speexify_payroll_snapshot_jobs_processing ${state.payroll.processingSnapshotJobs}`);

  lines.push("# HELP speexify_business_events_total Business events by domain and event");
  lines.push("# TYPE speexify_business_events_total counter");
  for (const [group, values] of Object.entries(state.business)) {
    for (const [field, value] of Object.entries(values)) {
      if (field === "latencySumMs") continue;
      lines.push(
        `speexify_business_events_total{domain="${escapePromLabel(group)}",event="${escapePromLabel(field)}"} ${value}`
      );
    }
    if (Object.prototype.hasOwnProperty.call(values, "latencySumMs")) {
      lines.push(
        `speexify_business_latency_ms_sum{domain="${escapePromLabel(group)}"} ${values.latencySumMs.toFixed(2)}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function resetMetricsForTests() {
  const fresh = createState();
  state.startedAtMs = fresh.startedAtMs;
  state.inflight = fresh.inflight;
  state.requestsTotal = fresh.requestsTotal;
  state.failedTotal = fresh.failedTotal;
  state.durationSumMs = fresh.durationSumMs;
  state.durationMinMs = fresh.durationMinMs;
  state.durationMaxMs = fresh.durationMaxMs;
  state.byStatus = fresh.byStatus;
  state.byRoute = fresh.byRoute;
  state.byRouteStatus = fresh.byRouteStatus;
  state.latencyBuckets = fresh.latencyBuckets;
  state.recentEvents = fresh.recentEvents;
  state.recentBusinessEvents = fresh.recentBusinessEvents;
  state.business = fresh.business;
  state.payroll = fresh.payroll;
}
