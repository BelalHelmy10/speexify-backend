// src/config/session.js
import { isProd, COOKIE_DOMAIN } from "./env.js";

export const SESSION_COOKIE_NAME = "speexify.sid";

export const sessionCookieOptions = {
  httpOnly: true,
  secure: isProd, // only secure in production
  sameSite: "lax", // tighten to "strict" if your flow allows
  domain: COOKIE_DOMAIN || undefined,
  path: "/",
  // If you want a fixed session lifetime, uncomment:
  // maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};
