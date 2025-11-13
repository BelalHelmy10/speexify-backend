// src/middleware/session.js
import session from "express-session";
import { isProd, SESSION_SECRET, COOKIE_DOMAIN } from "../config/env.js";

if (!SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set. Using an insecure fallback for dev."
  );
}

const cookieDomain = COOKIE_DOMAIN || undefined;
console.log("Session cookie domain:", cookieDomain ?? "(host-only)");

export const sessionMiddleware = session({
  name: "speexify.sid",
  secret: SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    domain: cookieDomain,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24, // 1 day
  },
});
