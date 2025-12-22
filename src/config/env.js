// src/config/env.js
// Central place for environment variables & config

// NODE_ENV flag
export const isProd = process.env.NODE_ENV === "production";

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
    "REDIS_URL must be set in production (required for sessions)"
  );
}

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
export const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY || "";
export const PAYMOB_INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID || "";
export const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID || "";
export const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || "";

// Log level (pino): "debug", "info", "warn", "error"
export const LOG_LEVEL =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");
