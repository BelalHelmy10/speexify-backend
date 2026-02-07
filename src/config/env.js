// src/config/env.js
// Central place for environment variables & config

// NODE_ENV flag
export const isProd = process.env.NODE_ENV === "production";
export const isTest = process.env.NODE_ENV === "test";

// Port
export const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

// Sessions / cookies
export const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-secret-change-me";

if (isProd && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}

// Redis
export const REDIS_URL = process.env.REDIS_URL || "";

if (isProd && !REDIS_URL) {
  throw new Error(
    "REDIS_URL must be set in production (required for sessions)",
  );
}

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
