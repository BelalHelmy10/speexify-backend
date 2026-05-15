// src/config/env.js
// Central place for environment variables & config

// NODE_ENV flag
export const isProd = process.env.NODE_ENV === "production";
export const isTest = process.env.NODE_ENV === "test";

const DEV_SESSION_SECRET = "dev-secret-change-me";
const INSECURE_SECRET_VALUES = new Set([
  "dev-secret-change-me",
  "dev-secret",
  "secret",
  "changeme",
  "change-me",
]);

// Port
export const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

function parseBooleanEnv(name, fallback = false) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") return fallback;

  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveIntEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") return fallback;

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseNonNegativeNumberEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") return fallback;

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseUnitIntervalEnv(name, fallback) {
  const parsed = parseNonNegativeNumberEnv(name, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed > 1) return fallback;
  return parsed;
}

function readSecretEnv(name, fallback = "") {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") return fallback;
  return String(rawValue).trim();
}

function requireProductionSecret(name, value, { minLength = 32 } = {}) {
  if (!isProd) return;

  if (!value) {
    throw new Error(`${name} must be set in production`);
  }

  const normalized = String(value).trim().toLowerCase();
  if (
    INSECURE_SECRET_VALUES.has(normalized) ||
    normalized.includes("change-me") ||
    normalized.includes("dev-secret")
  ) {
    throw new Error(`${name} must not use an insecure development secret`);
  }

  if (String(value).length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }
}

// Sessions / cookies
const rawSessionSecret = readSecretEnv("SESSION_SECRET");
export const SESSION_SECRET = rawSessionSecret || DEV_SESSION_SECRET;

if (isProd && !rawSessionSecret) {
  throw new Error("SESSION_SECRET must be set in production");
}

requireProductionSecret("SESSION_SECRET", SESSION_SECRET);

export const WS_AUTH_TOKEN_SECRET = readSecretEnv(
  "WS_AUTH_TOKEN_SECRET",
  SESSION_SECRET
);
requireProductionSecret("WS_AUTH_TOKEN_SECRET", WS_AUTH_TOKEN_SECRET);

export const CALENDAR_FEED_SECRET = readSecretEnv(
  "CALENDAR_FEED_SECRET",
  SESSION_SECRET
);
requireProductionSecret("CALENDAR_FEED_SECRET", CALENDAR_FEED_SECRET);

// Redis
export const REDIS_URL = process.env.REDIS_URL || "";

if (isProd && !REDIS_URL) {
  throw new Error(
    "REDIS_URL must be set in production (required for sessions)",
  );
}

// Session runtime behavior
export const SESSION_FORCE_MEMORY =
  isTest || parseBooleanEnv("SESSION_FORCE_MEMORY", false);
export const SESSION_REDIS_STRICT = parseBooleanEnv(
  "SESSION_REDIS_STRICT",
  false,
);
export const SESSION_REDIS_CONNECT_TIMEOUT_MS = parsePositiveIntEnv(
  "SESSION_REDIS_CONNECT_TIMEOUT_MS",
  3000,
);

// Cookie domain (optional)
export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

// CORS allowed origins (comma-separated list in env)
const rawAllowedOrigins =
  process.env.ALLOWED_ORIGINS || "http://localhost:3000";

export const ALLOWED_ORIGINS = rawAllowedOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Paymob config
export const PAYMOB_API_KEY = (process.env.PAYMOB_API_KEY || "").trim();
export const PAYMOB_INTEGRATION_ID = (
  process.env.PAYMOB_INTEGRATION_ID || ""
).trim();
export const PAYMOB_IFRAME_ID = (process.env.PAYMOB_IFRAME_ID || "").trim();
export const PAYMOB_HMAC_SECRET = (process.env.PAYMOB_HMAC_SECRET || "").trim();
export const PAYMOB_SECRET_KEY = (process.env.PAYMOB_SECRET_KEY || "").trim();
export const PAYMOB_PUBLIC_KEY = (process.env.PAYMOB_PUBLIC_KEY || "").trim();

// Log level (pino): "debug", "info", "warn", "error"
export const LOG_LEVEL =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");

// Observability: tracing
export const SENTRY_TRACES_SAMPLE_RATE = parseUnitIntervalEnv(
  "SENTRY_TRACES_SAMPLE_RATE",
  isProd ? 0.1 : 1
);
export const SENTRY_PROFILES_SAMPLE_RATE = parseUnitIntervalEnv(
  "SENTRY_PROFILES_SAMPLE_RATE",
  0
);

// Observability: metrics / alerting
export const OBS_METRICS_TOKEN = (process.env.OBS_METRICS_TOKEN || "").trim();

export const OBS_ALERTS_ENABLED = parseBooleanEnv("OBS_ALERTS_ENABLED", !isTest);
export const OBS_ALERT_WEBHOOK_URL = (process.env.OBS_ALERT_WEBHOOK_URL || "").trim();

export const OBS_ALERT_WINDOW_MS = parsePositiveIntEnv(
  "OBS_ALERT_WINDOW_MS",
  5 * 60 * 1000
);
export const OBS_ALERT_CHECK_INTERVAL_MS = parsePositiveIntEnv(
  "OBS_ALERT_CHECK_INTERVAL_MS",
  60 * 1000
);
export const OBS_ALERT_COOLDOWN_MS = parsePositiveIntEnv(
  "OBS_ALERT_COOLDOWN_MS",
  10 * 60 * 1000
);
export const OBS_ALERT_ERROR_RATE_PCT = parseNonNegativeNumberEnv(
  "OBS_ALERT_ERROR_RATE_PCT",
  5
);
export const OBS_ALERT_P95_MS = parsePositiveIntEnv(
  "OBS_ALERT_P95_MS",
  1200
);
export const OBS_ALERT_MIN_REQUESTS = parsePositiveIntEnv(
  "OBS_ALERT_MIN_REQUESTS",
  100
);

// Privacy / compliance
export const PRIVACY_CONTACT_EMAIL = (
  process.env.PRIVACY_CONTACT_EMAIL || "privacy@speexify.com"
)
  .trim()
  .toLowerCase();

export const PRIVACY_POLICY_VERSION = (
  process.env.PRIVACY_POLICY_VERSION || "2026-01"
).trim();

export const PRIVACY_RETENTION_DAYS_VERIFICATION_CODES = parsePositiveIntEnv(
  "PRIVACY_RETENTION_DAYS_VERIFICATION_CODES",
  30
);
export const PRIVACY_RETENTION_DAYS_NOTIFICATIONS = parsePositiveIntEnv(
  "PRIVACY_RETENTION_DAYS_NOTIFICATIONS",
  180
);
export const PRIVACY_RETENTION_DAYS_AUDITS = parsePositiveIntEnv(
  "PRIVACY_RETENTION_DAYS_AUDITS",
  730
);
export const PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS = parsePositiveIntEnv(
  "PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS",
  730
);
