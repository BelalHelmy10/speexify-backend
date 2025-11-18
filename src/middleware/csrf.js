// src/middleware/csrf.js
import csurf from "csurf";

// Configure csurf middleware
const rawCsrf = csurf({
  cookie: false,
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
});

// Paths that should NOT require a CSRF token
// (webhooks, OAuth redirects, etc.)
const CSRF_EXCLUDE_PREFIXES = [
  "/payments/webhook", // Paymob webhook
  "/api/auth/google", // Google login redirect
  "/api/auth/google/callback",
];

// ------------------------------------------------------------
// Main CSRF middleware
// ------------------------------------------------------------
export function csrfMiddleware(req, res, next) {
  // Skip ALL CSRF checks completely in tests
  if (process.env.NODE_ENV === "test") {
    return next();
  }

  const url = req.originalUrl || req.url || "";

  // 🔹 Special case:
  // The CSRF token endpoint MUST run csurf, or req.csrfToken() will not exist.
  if (url.startsWith("/api/csrf-token")) {
    return rawCsrf(req, res, next);
  }

  // 🔹 Skip CSRF checks for externally triggered routes
  if (CSRF_EXCLUDE_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return next();
  }

  // 🔹 All other POST/PUT/PATCH/DELETE go through csurf
  return rawCsrf(req, res, next);
}

// ------------------------------------------------------------
// CSRF Error handler
// ------------------------------------------------------------
export function csrfErrorHandler(err, req, res, next) {
  if (err.code !== "EBADCSRFTOKEN") return next(err);
  return res.status(403).json({ error: "Invalid CSRF token" });
}
