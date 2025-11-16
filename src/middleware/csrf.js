// src/middleware/csrf.js
import csurf from "csurf";

// Use session-based CSRF tokens (no extra cookie)
const rawCsrf = csurf({
  cookie: false,
  ignoreMethods: ["GET", "HEAD", "OPTIONS"], // only check mutating requests
});

// Wrap to skip external webhooks etc.
export function csrfMiddleware(req, res, next) {
  const path = req.path || "";

  // Skip CSRF for Paymob webhook (called by Paymob servers, not browsers)
  if (path.startsWith("/payments/webhook")) {
    return next();
  }

  return rawCsrf(req, res, next);
}

// Centralised handler for CSRF errors
export function csrfErrorHandler(err, req, res, next) {
  if (err.code !== "EBADCSRFTOKEN") return next(err);
  return res.status(403).json({ error: "Invalid CSRF token" });
}
