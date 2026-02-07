// src/middleware/csrf.js
import csurf from "csurf";

// ------------------------------------------------------------
// Create base csurf instance
// ------------------------------------------------------------
const rawCsrf = csurf({
  cookie: false,
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
});

/**
 * Check if URL should be excluded from CSRF protection
 */
function shouldExcludeCsrf(url) {
  // Normalize URL for consistent matching
  let normalizedPath = "";
  try {
    normalizedPath = new URL(url || "", "http://localhost").pathname.toLowerCase();
  } catch {
    normalizedPath = String(url || "")
      .split("?")[0]
      .toLowerCase();
  }

  // Explicit list of excluded paths
  const excludedPaths = [
    // Auth flows
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/register",
    "/api/auth/password",
    "/api/auth/google",
    // Webhooks
    "/api/payments/webhook",
    "/payments/webhook",
  ];

  // Check exact prefix matches
  for (const path of excludedPaths) {
    if (normalizedPath.startsWith(path)) {
      return true;
    }
  }

  return false;
}

// ------------------------------------------------------------
// Main CSRF middleware
// ------------------------------------------------------------
export function csrfMiddleware(req, res, next) {
  // Skip entirely in automated test mode
  if (process.env.NODE_ENV === "test") {
    return next();
  }

  const url = req.originalUrl || req.path || "";

  // Debug logging
  if (process.env.NODE_ENV !== "production") {
    const method = req.method;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      console.log("[CSRF] Checking:", method, url);
    }
  }

  // CSRF TOKEN ENDPOINT: must generate token
  if (url.startsWith("/api/csrf-token")) {
    return rawCsrf(req, res, next);
  }

  // Check exclusions
  if (shouldExcludeCsrf(url)) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[CSRF] EXCLUDED:", url);
    }
    return next();
  }

  // All other write operations require CSRF
  return rawCsrf(req, res, next);
}

// ------------------------------------------------------------
// CSRF Error Handler
// ------------------------------------------------------------
export function csrfErrorHandler(err, req, res, next) {
  if (err.code !== "EBADCSRFTOKEN") {
    return next(err);
  }

  console.error(
    "[CSRF] Token validation FAILED:",
    req.method,
    req.originalUrl || req.path
  );

  return res.status(403).json({
    error: "Invalid CSRF token",
  });
}
