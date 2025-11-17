// src/middleware/csrf.js
import csurf from "csurf";

const rawCsrf = csurf({
  cookie: false,
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
});

// Paths that should NOT require a CSRF token
// (use full /api/... form because your auth router is mounted under /api)
const CSRF_EXCLUDE_PREFIXES = [
  "/api/csrf-token", // your CSRF token fetch endpoint (if you have one)
  "/api/auth/google", // Google login POST
  // add more if needed:
  // "/api/auth/google/callback",
  // "/api/auth/google/verify",
  "/payments/webhook", // external Paymob webhook (already excluded before)
];

export function csrfMiddleware(req, res, next) {
  // 🔹 In tests, completely skip CSRF checks
  if (process.env.NODE_ENV === "test") {
    return next();
  }

  const url = req.originalUrl || req.url || "";
  // Skip CSRF for excluded paths
  if (CSRF_EXCLUDE_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return next();
  }

  // All other non-GET/HEAD/OPTIONS requests go through csurf
  return rawCsrf(req, res, next);
}

export function csrfErrorHandler(err, req, res, next) {
  if (err.code !== "EBADCSRFTOKEN") return next(err);
  return res.status(403).json({ error: "Invalid CSRF token" });
}
