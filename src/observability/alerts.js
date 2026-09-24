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

  if (
    snapshot.window.requests >= OBS_ALERT_MIN_REQUESTS &&
    snapshot.window.errorRatePct >= OBS_ALERT_ERROR_RATE_PCT
  ) {
    alerts.push({
      key: "error-rate",
      severity: "critical",
      title: "High API error rate",
      threshold: `${OBS_ALERT_ERROR_RATE_PCT}%`,
      actual: `${snapshot.window.errorRatePct}%`,
      value: snapshot.window.errorRatePct,
    });
  }

  if (
    snapshot.window.requests >= OBS_ALERT_MIN_REQUESTS &&
    snapshot.window.p95Ms >= OBS_ALERT_P95_MS
  ) {
    alerts.push({
      key: "latency-p95",
      severity: "warning",
      title: "High API latency (p95)",
      threshold: `${OBS_ALERT_P95_MS}ms`,
      actual: `${snapshot.window.p95Ms}ms`,
      value: snapshot.window.p95Ms,
    });
  }

  const business = snapshot.business?.window || {};
  const pricing = business.pricingCatalog || {};
  const cms = business.cms || {};
  const email = business.email || {};
  const payments = business.paymentWebhooks || {};
  const auth = business.auth || {};

  if ((snapshot.payroll?.missingEarnings || 0) > 0) {
    alerts.push({
      key: "payroll-missing-earnings",
      severity: "critical",
      title: "Completed sessions are missing teacher earnings",
      threshold: "0 missing earnings",
      actual: String(snapshot.payroll.missingEarnings),
      value: snapshot.payroll.missingEarnings,
      context: { payroll: snapshot.payroll },
    });
  }

  if ((snapshot.payroll?.failedSnapshotJobs || 0) > 0) {
    alerts.push({
      key: "payroll-failed-snapshot-jobs",
      severity: "critical",
      title: "Teacher earning snapshot jobs are failing",
      threshold: "0 failed jobs",
      actual: String(snapshot.payroll.failedSnapshotJobs),
      value: snapshot.payroll.failedSnapshotJobs,
      context: { payroll: snapshot.payroll },
    });
  }

  if (pricing.requests >= 5 && pricing.failures / pricing.requests >= 0.2) {
    alerts.push({
      key: "pricing-catalog-availability",
      severity: "critical",
      title: "Pricing catalog availability is degraded",
      threshold: "<20% failed catalog requests",
      actual: `${pricing.failures}/${pricing.requests} failed`,
      value: pricing.failures / pricing.requests,
    });
  }

  if (cms.queries >= 5 && cms.failures / cms.queries >= 0.2) {
    alerts.push({
      key: "cms-query-failures",
      severity: "warning",
      title: "CMS query failures are elevated",
      threshold: "<20% failed CMS queries",
      actual: `${cms.failures}/${cms.queries} failed`,
      value: cms.failures / cms.queries,
    });
  }

  if (cms.slowQueries >= 5) {
    alerts.push({
      key: "cms-query-latency",
      severity: "warning",
      title: "CMS query latency is elevated",
      threshold: "<5 slow queries",
      actual: String(cms.slowQueries),
      value: cms.slowQueries,
    });
  }

  if ((email.queueFailures || 0) > 0) {
    alerts.push({
      key: "email-queue-failures",
      severity: "critical",
      title: "Transactional email queue handoff failed",
      threshold: "0 queue failures",
      actual: String(email.queueFailures),
      value: email.queueFailures,
    });
  }

  if ((email.bounced || 0) > 0 || (email.complained || 0) > 0) {
    alerts.push({
      key: "email-provider-feedback",
      severity: "warning",
      title: "Email provider reported bounces or complaints",
      threshold: "0 bounces or complaints",
      actual: `${email.bounced || 0} bounced, ${email.complained || 0} complained`,
      value: (email.bounced || 0) + (email.complained || 0),
    });
  }

  if ((payments.unreconciled || 0) > 0 || (payments.failed || 0) > 0) {
    alerts.push({
      key: "payment-webhook-reconciliation",
      severity: "critical",
      title: "Payment webhook reconciliation needs attention",
      threshold: "0 failed or unreconciled webhooks",
      actual: `${payments.failed || 0} failed, ${payments.unreconciled || 0} unreconciled`,
      value: (payments.failed || 0) + (payments.unreconciled || 0),
    });
  }

  if ((auth.transientFailures || 0) >= 3) {
    alerts.push({
      key: "auth-transient-failures",
      severity: "warning",
      title: "Authentication service transient failures increased",
      threshold: "<3 transient failures",
      actual: String(auth.transientFailures),
      value: auth.transientFailures,
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

export async function notifyOperationalAlert({
  key,
  severity = "critical",
  title,
  actual,
  value,
  context = {},
} = {}) {
  const alertKey = String(key || "operational-alert");
  if (!shouldSendAlert(alertKey)) return false;

  const payload = {
    source: "speexify-backend",
    ts: new Date().toISOString(),
    alert: {
      key: alertKey,
      severity,
      title: title || alertKey,
      actual: actual || null,
      value: value ?? null,
      context,
    },
  };

  logger.error(payload, "[observability] operational alert fired");
  await sendWebhook(payload);
  return true;
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
