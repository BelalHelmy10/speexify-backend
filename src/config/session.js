// src/config/session.js
import { isProd, COOKIE_DOMAIN } from "./env.js";

export const SESSION_COOKIE_NAME = "speexify.sid";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionCookieOptions = {
  httpOnly: true,
  secure: isProd, // only secure in production
  sameSite: "lax", // tighten to "strict" if your flow allows
  domain: COOKIE_DOMAIN || undefined,
  path: "/",
  maxAge: SESSION_MAX_AGE_MS,
};
