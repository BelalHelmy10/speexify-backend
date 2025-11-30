// src/config/session.js
import { env } from "./env.js";

export const SESSION_COOKIE_NAME = "speexify.sid";

export const sessionCookieOptions = {
  httpOnly: true,
  secure: env.isProd, // only secure in prod
  sameSite: "lax", // "strict" if your flow allows it
  domain: env.COOKIE_DOMAIN || undefined,
  path: "/",
  // Set maxAge if you want fixed session lifetime, e.g. 7 days:
  // maxAge: 7 * 24 * 60 * 60 * 1000,
};
