import csurf from "csurf";

const rawCsrf = csurf({
  cookie: false,
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
});

export function csrfMiddleware(req, res, next) {
  // 🔹 In tests, completely skip CSRF checks
  if (process.env.NODE_ENV === "test") {
    return next();
  }

  const path = req.path || "";

  // Skip CSRF for Paymob webhook (external service)
  if (path.startsWith("/payments/webhook")) {
    return next();
  }

  return rawCsrf(req, res, next);
}

export function csrfErrorHandler(err, req, res, next) {
  if (err.code !== "EBADCSRFTOKEN") return next(err);
  return res.status(403).json({ error: "Invalid CSRF token" });
}
