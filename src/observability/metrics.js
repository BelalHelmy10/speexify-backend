const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10000];
const MAX_RECENT_WINDOW_MS = 15 * 60 * 1000;

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
  pruneRecent(observedAtMs);
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
}
