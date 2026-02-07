import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";

const BASE_URL = String(process.env.LOADTEST_BASE_URL || "http://localhost:5050").replace(
  /\/+$/,
  ""
);
const REQUEST_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.LOADTEST_TIMEOUT_MS || 5000)
);
const LOAD_SCALE = Math.max(0.05, Number(process.env.LOADTEST_SCALE || 1));

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

const ENDPOINTS = [
  { name: "health", method: "GET", path: "/health", weight: 0.2, expected: [200] },
  { name: "message", method: "GET", path: "/api/message", weight: 0.2, expected: [200] },
  {
    name: "csrf-token",
    method: "GET",
    path: "/api/csrf-token",
    weight: 0.2,
    expected: [200],
  },
  {
    name: "packages",
    method: "GET",
    path: "/api/packages?audience=INDIVIDUAL",
    weight: 0.4,
    expected: [200],
  },
];

const SCENARIOS = {
  "10k": {
    label: "10k users",
    targetRps: 120,
    durationSec: 300,
    rampSec: 60,
    maxInflight: 350,
    slo: {
      availabilityPct: 99.5,
      p95Ms: 500,
      p99Ms: 1000,
      maxInjectorDropPct: 1,
    },
  },
  "100k": {
    label: "100k users",
    targetRps: 900,
    durationSec: 600,
    rampSec: 120,
    maxInflight: 1500,
    slo: {
      availabilityPct: 99.0,
      p95Ms: 800,
      p99Ms: 1800,
      maxInjectorDropPct: 2,
    },
  },
  "1m": {
    label: "1M users",
    targetRps: 6000,
    durationSec: 900,
    rampSec: 180,
    maxInflight: 8000,
    slo: {
      availabilityPct: 98.5,
      p95Ms: 1200,
      p99Ms: 2500,
      maxInjectorDropPct: 5,
    },
  },
};

const scenarioName = String(process.argv[2] || process.env.LOADTEST_SCENARIO || "10k")
  .trim()
  .toLowerCase();
const scenario = SCENARIOS[scenarioName];

if (!scenario) {
  console.error(
    `Unknown scenario "${scenarioName}". Use one of: ${Object.keys(SCENARIOS).join(", ")}`
  );
  process.exit(1);
}

const effective = {
  ...scenario,
  targetRps: Math.max(1, Math.round(scenario.targetRps * LOAD_SCALE)),
  maxInflight: parsePositiveInt(
    process.env.LOADTEST_MAX_INFLIGHT,
    Math.max(50, Math.round(scenario.maxInflight * LOAD_SCALE))
  ),
  durationSec: parsePositiveInt(
    process.env.LOADTEST_DURATION_SEC,
    scenario.durationSec
  ),
  rampSec: parsePositiveInt(process.env.LOADTEST_RAMP_SEC, scenario.rampSec),
};

const HISTOGRAM_BUCKET_MS = 10;
const HISTOGRAM_MAX_MS = 10000;
const histogram = new Array(Math.floor(HISTOGRAM_MAX_MS / HISTOGRAM_BUCKET_MS) + 1).fill(0);

const metrics = {
  scheduled: 0,
  started: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  timeouts: 0,
  droppedByInjector: 0,
  totalLatencyMs: 0,
  minLatencyMs: Number.POSITIVE_INFINITY,
  maxLatencyMs: 0,
  byStatus: new Map(),
  byEndpoint: new Map(),
};

let inflight = 0;
let ticker = null;
let stopRequested = false;
let fractionalCarry = 0;

function pickEndpoint() {
  const r = Math.random();
  let cumulative = 0;
  for (const endpoint of ENDPOINTS) {
    cumulative += endpoint.weight;
    if (r <= cumulative) return endpoint;
  }
  return ENDPOINTS[ENDPOINTS.length - 1];
}

function recordLatency(ms) {
  const clamped = Math.max(0, Math.min(HISTOGRAM_MAX_MS, ms));
  const idx = Math.floor(clamped / HISTOGRAM_BUCKET_MS);
  histogram[idx] += 1;

  metrics.totalLatencyMs += ms;
  metrics.minLatencyMs = Math.min(metrics.minLatencyMs, ms);
  metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, ms);
}

function quantileMs(q) {
  if (metrics.completed === 0) return 0;
  const target = Math.ceil(metrics.completed * q);
  let cumulative = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    cumulative += histogram[i];
    if (cumulative >= target) {
      return i * HISTOGRAM_BUCKET_MS;
    }
  }
  return HISTOGRAM_MAX_MS;
}

async function runRequest() {
  if (inflight >= effective.maxInflight) {
    metrics.droppedByInjector += 1;
    return;
  }

  const endpoint = pickEndpoint();
  const url = `${BASE_URL}${endpoint.path}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  inflight += 1;
  metrics.started += 1;
  const t0 = performance.now();

  try {
    const res = await fetch(url, {
      method: endpoint.method,
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    await res.arrayBuffer();

    const elapsed = performance.now() - t0;
    metrics.completed += 1;
    recordLatency(elapsed);

    const statusKey = String(res.status);
    metrics.byStatus.set(statusKey, (metrics.byStatus.get(statusKey) || 0) + 1);
    metrics.byEndpoint.set(
      endpoint.name,
      (metrics.byEndpoint.get(endpoint.name) || 0) + 1
    );

    if (endpoint.expected.includes(res.status)) {
      metrics.succeeded += 1;
    } else {
      metrics.failed += 1;
    }
  } catch (err) {
    const elapsed = performance.now() - t0;
    metrics.completed += 1;
    recordLatency(elapsed);
    metrics.failed += 1;
    if (err?.name === "AbortError") {
      metrics.timeouts += 1;
    }
    metrics.byStatus.set("network_error", (metrics.byStatus.get("network_error") || 0) + 1);
  } finally {
    clearTimeout(timeoutHandle);
    inflight -= 1;
  }
}

function formatPct(value) {
  return `${value.toFixed(2)}%`;
}

function evaluateSlo(summary) {
  const rules = [
    {
      key: "availability",
      label: `Availability >= ${effective.slo.availabilityPct}%`,
      pass: summary.availabilityPct >= effective.slo.availabilityPct,
      actual: `${summary.availabilityPct.toFixed(2)}%`,
    },
    {
      key: "p95",
      label: `p95 <= ${effective.slo.p95Ms}ms`,
      pass: summary.p95Ms <= effective.slo.p95Ms,
      actual: `${summary.p95Ms}ms`,
    },
    {
      key: "p99",
      label: `p99 <= ${effective.slo.p99Ms}ms`,
      pass: summary.p99Ms <= effective.slo.p99Ms,
      actual: `${summary.p99Ms}ms`,
    },
    {
      key: "injector_drop",
      label: `Injector drop <= ${effective.slo.maxInjectorDropPct}%`,
      pass: summary.injectorDropPct <= effective.slo.maxInjectorDropPct,
      actual: `${summary.injectorDropPct.toFixed(2)}%`,
    },
  ];

  const ok = rules.every((rule) => rule.pass);
  return { ok, rules };
}

function waitForInflightDrain() {
  return new Promise((resolveDrain) => {
    const poll = setInterval(() => {
      if (inflight === 0) {
        clearInterval(poll);
        resolveDrain();
      }
    }, 50);
  });
}

function scheduleLoop(startMs) {
  const tickMs = 100;

  ticker = setInterval(() => {
    const elapsedSec = (Date.now() - startMs) / 1000;
    if (elapsedSec >= effective.durationSec) {
      stopRequested = true;
      clearInterval(ticker);
      return;
    }

    const rampFactor = Math.min(1, elapsedSec / effective.rampSec);
    const targetPerSecond = effective.targetRps * rampFactor;
    const targetThisTick = targetPerSecond * (tickMs / 1000) + fractionalCarry;
    const launches = Math.floor(targetThisTick);
    fractionalCarry = targetThisTick - launches;

    metrics.scheduled += launches;
    for (let i = 0; i < launches; i += 1) {
      void runRequest();
    }
  }, tickMs);
}

async function main() {
  console.log("Speexify Load Test Runner");
  console.log(`Scenario: ${scenarioName} (${effective.label})`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Target RPS: ${effective.targetRps} (scale=${LOAD_SCALE})`);
  console.log(`Duration: ${effective.durationSec}s | Ramp: ${effective.rampSec}s`);
  console.log(`Max inflight: ${effective.maxInflight}`);
  console.log(`Request timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log("");

  const wallStart = Date.now();
  scheduleLoop(wallStart);

  while (!stopRequested) {
    await new Promise((r) => setTimeout(r, 250));
  }

  await waitForInflightDrain();

  const durationSec = Math.max(1, (Date.now() - wallStart) / 1000);
  const availabilityPct =
    metrics.completed > 0 ? (metrics.succeeded / metrics.completed) * 100 : 0;
  const failurePct = metrics.completed > 0 ? (metrics.failed / metrics.completed) * 100 : 0;
  const injectorDropPct =
    metrics.scheduled > 0 ? (metrics.droppedByInjector / metrics.scheduled) * 100 : 0;

  const summary = {
    scenario: scenarioName,
    label: effective.label,
    baseUrl: BASE_URL,
    durationSec,
    targetRps: effective.targetRps,
    achievedRps: Number((metrics.completed / durationSec).toFixed(2)),
    scheduled: metrics.scheduled,
    started: metrics.started,
    completed: metrics.completed,
    succeeded: metrics.succeeded,
    failed: metrics.failed,
    timeouts: metrics.timeouts,
    availabilityPct: Number(availabilityPct.toFixed(2)),
    failurePct: Number(failurePct.toFixed(2)),
    injectorDropPct: Number(injectorDropPct.toFixed(2)),
    latencyAvgMs:
      metrics.completed > 0
        ? Number((metrics.totalLatencyMs / metrics.completed).toFixed(2))
        : 0,
    latencyMinMs:
      metrics.minLatencyMs === Number.POSITIVE_INFINITY
        ? 0
        : Number(metrics.minLatencyMs.toFixed(2)),
    latencyMaxMs: Number(metrics.maxLatencyMs.toFixed(2)),
    p95Ms: quantileMs(0.95),
    p99Ms: quantileMs(0.99),
    byStatus: Object.fromEntries(metrics.byStatus.entries()),
    byEndpoint: Object.fromEntries(metrics.byEndpoint.entries()),
    slo: effective.slo,
    generatedAt: new Date().toISOString(),
  };

  const sloResult = evaluateSlo(summary);
  summary.sloResult = sloResult;

  console.log("Summary");
  console.log(`- Achieved RPS: ${summary.achievedRps}`);
  console.log(
    `- Availability: ${formatPct(summary.availabilityPct)} | Failures: ${formatPct(
      summary.failurePct
    )} | Timeouts: ${summary.timeouts}`
  );
  console.log(
    `- Latency ms (avg/p95/p99/max): ${summary.latencyAvgMs}/${summary.p95Ms}/${summary.p99Ms}/${summary.latencyMaxMs}`
  );
  console.log(`- Injector drop: ${formatPct(summary.injectorDropPct)}`);
  console.log("");

  console.log("SLO Check");
  for (const rule of sloResult.rules) {
    console.log(`- [${rule.pass ? "PASS" : "FAIL"}] ${rule.label} (actual: ${rule.actual})`);
  }

  const reportsDir = resolve("reports", "load");
  mkdirSync(reportsDir, { recursive: true });
  const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(reportsDir, `${safeStamp}-${scenarioName}.json`);
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`Report written: ${reportPath}`);

  if (!sloResult.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Load test runner failed", err);
  process.exit(1);
});
