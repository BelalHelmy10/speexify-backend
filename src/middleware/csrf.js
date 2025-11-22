// src/middleware/csrf.js
import csurf from "csurf";

// ------------------------------------------------------------
// Create base csurf instance
// ------------------------------------------------------------
const rawCsrf = csurf({
  cookie: false,
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
});

// ------------------------------------------------------------
// Routes that MUST NOT require CSRF
// (login, register, OAuth, public auth flows)
// ------------------------------------------------------------
const CSRF_EXCLUDE_PREFIXES = [
  // ---- AUTH FLOWS (EMAIL) ----
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/register/verify",
  "/api/auth/password/forgot",
  "/api/auth/password/reset",

  // ---- AUTH FLOWS (GOOGLE / OAUTH) ----
  "/api/auth/google",
  "/api/auth/google/callback",

  // ---- WEBHOOKS ----
  "/payments/webhook",
];

// ------------------------------------------------------------
// Main CSRF middleware
// ------------------------------------------------------------
export function csrfMiddleware(req, res, next) {
  // Skip entirely in automated test mode
  if (process.env.NODE_ENV === "test") {
    return next();
  }

  const url = req.originalUrl || req.url || "";

  // CSRF Token endpoint MUST generate a valid token
  if (url.startsWith("/api/csrf-token")) {
    return rawCsrf(req, res, next);
  }

  // Skip CSRF for excluded paths
  if (CSRF_EXCLUDE_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return next();
  }

  // All other write operations require CSRF
  return rawCsrf(req, res, next);
}

// ------------------------------------------------------------
// CSRF Error Handler
// ------------------------------------------------------------
export function csrfErrorHandler(err, req, res, next) {
  if (err.code !== "EBADCSRFTOKEN") return next(err);

  return res.status(403).json({
    error: "Invalid CSRF token",
  });
}
