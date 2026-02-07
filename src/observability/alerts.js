import {
  OBS_ALERTS_ENABLED,
  OBS_ALERT_WINDOW_MS,
  OBS_ALERT_CHECK_INTERVAL_MS,
  OBS_ALERT_COOLDOWN_MS,
  OBS_ALERT_ERROR_RATE_PCT,
  OBS_ALERT_P95_MS,
  OBS_ALERT_MIN_REQUESTS,
  OBS_ALERT_WEBHOOK_URL,
} from "../config/env.js";
import { logger } from "../lib/logger.js";
import { getMetricsSnapshot } from "./metrics.js";

const lastAlertAtByKey = new Map();

let intervalHandle = null;

function nowMs() {
  return Date.now();
}

function shouldSendAlert(key) {
  const last = lastAlertAtByKey.get(key) || 0;
  const delta = nowMs() - last;
  if (delta < OBS_ALERT_COOLDOWN_MS) return false;
  lastAlertAtByKey.set(key, nowMs());
  return true;
}

function buildAlertCandidates(snapshot) {
  const alerts = [];

  if (snapshot.window.requests < OBS_ALERT_MIN_REQUESTS) {
    return alerts;
  }

  if (snapshot.window.errorRatePct >= OBS_ALERT_ERROR_RATE_PCT) {
    alerts.push({
      key: "error-rate",
      severity: "critical",
      title: "High API error rate",
      threshold: `${OBS_ALERT_ERROR_RATE_PCT}%`,
      actual: `${snapshot.window.errorRatePct}%`,
      value: snapshot.window.errorRatePct,
    });
  }

  if (snapshot.window.p95Ms >= OBS_ALERT_P95_MS) {
    alerts.push({
      key: "latency-p95",
      severity: "warning",
      title: "High API latency (p95)",
      threshold: `${OBS_ALERT_P95_MS}ms`,
      actual: `${snapshot.window.p95Ms}ms`,
      value: snapshot.window.p95Ms,
    });
  }

  return alerts;
}

async function sendWebhook(alertPayload) {
  if (!OBS_ALERT_WEBHOOK_URL) return;

  try {
    const res = await fetch(OBS_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alertPayload),
    });

    if (!res.ok) {
      logger.error(
        { status: res.status, statusText: res.statusText },
        "[observability] alert webhook failed"
      );
    }
  } catch (err) {
    logger.error({ err }, "[observability] alert webhook request failed");
  }
}

async function evaluateAndAlert() {
  try {
    const snapshot = getMetricsSnapshot({ windowMs: OBS_ALERT_WINDOW_MS });
    const candidates = buildAlertCandidates(snapshot);

    for (const candidate of candidates) {
      if (!shouldSendAlert(candidate.key)) {
        continue;
      }

      const payload = {
        source: "speexify-backend",
        ts: new Date().toISOString(),
        alert: candidate,
        window: snapshot.window,
      };

      logger.error(payload, "[observability] alert fired");
      await sendWebhook(payload);
    }
  } catch (err) {
    logger.error({ err }, "[observability] alert evaluation failed");
  }
}

export function startObservabilityAlerts() {
  if (!OBS_ALERTS_ENABLED) {
    logger.info("[observability] alert loop disabled");
    return () => {};
  }

  if (intervalHandle) {
    return () => {};
  }

  intervalHandle = setInterval(() => {
    void evaluateAndAlert();
  }, OBS_ALERT_CHECK_INTERVAL_MS);

  if (typeof intervalHandle.unref === "function") {
    intervalHandle.unref();
  }

  logger.info(
    {
      windowMs: OBS_ALERT_WINDOW_MS,
      checkIntervalMs: OBS_ALERT_CHECK_INTERVAL_MS,
      cooldownMs: OBS_ALERT_COOLDOWN_MS,
      errorRatePctThreshold: OBS_ALERT_ERROR_RATE_PCT,
      p95MsThreshold: OBS_ALERT_P95_MS,
      minRequests: OBS_ALERT_MIN_REQUESTS,
      webhookConfigured: !!OBS_ALERT_WEBHOOK_URL,
    },
    "[observability] alert loop started"
  );

  return () => {
    if (!intervalHandle) return;
    clearInterval(intervalHandle);
    intervalHandle = null;
  };
}
