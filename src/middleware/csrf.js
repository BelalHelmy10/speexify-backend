// src/middleware/csrf.js
import crypto from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER_NAMES = ["csrf-token", "x-csrf-token"];

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getSessionToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) req.session.csrfToken = createToken();
  return req.session.csrfToken;
}

function tokensMatch(given, expected) {
  const givenBuffer = Buffer.from(String(given || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return (
    givenBuffer.length > 0 &&
    givenBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(givenBuffer, expectedBuffer)
  );
}

function csrfError() {
  const error = new Error("Invalid CSRF token");
  error.code = "EBADCSRFTOKEN";
  return error;
}

function applyCsrfTokenApi(req) {
  req.csrfToken = () => getSessionToken(req);
  return req.csrfToken();
}

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
  const url = req.originalUrl || req.path || "";

  applyCsrfTokenApi(req);

  // CSRF TOKEN ENDPOINT: must generate token, including in automated tests.
  if (url.startsWith("/api/csrf-token")) {
    return next();
  }

  // Skip validation in automated test mode after token generation remains available.
  if (process.env.NODE_ENV === "test") {
    return next();
  }

  // Debug logging
  if (process.env.NODE_ENV !== "production") {
    const method = req.method;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      console.log("[CSRF] Checking:", method, url);
    }
  }

  // Check exclusions
  if (shouldExcludeCsrf(url)) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[CSRF] EXCLUDED:", url);
    }
    return next();
  }

  if (SAFE_METHODS.has(req.method)) return next();

  const expected = getSessionToken(req);
  const given = CSRF_HEADER_NAMES.map((name) => req.get(name)).find(Boolean);

  // All other write operations require a token bound to the current session.
  if (!tokensMatch(given, expected)) return next(csrfError());
  return next();
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
