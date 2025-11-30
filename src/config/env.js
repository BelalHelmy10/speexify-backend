// src/config/env.ts
// Central place for environment variables & config
// NODE_ENV flag
export const isProd = process.env.NODE_ENV === "production";
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}
// Port (used in index.js and possibly elsewhere)
export const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;
// Session / cookies
export const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-secret-change-me";
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
// You can add more later (SMTP, Google client ID, etc.)

// Log level (pino): "debug", "info", "warn", "error"
export const LOG_LEVEL =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "info" : "debug");
