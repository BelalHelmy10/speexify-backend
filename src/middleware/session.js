// src/middleware/session.js
import session from "express-session";
import { SESSION_SECRET } from "../config/env.js";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "../config/session.js";

if (!SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set. Using an insecure fallback for dev."
  );
}

export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    ...sessionCookieOptions,
    // (optional) If you want server-controlled expiration:
    // maxAge: 24 * 60 * 60 * 1000,
  },
});
