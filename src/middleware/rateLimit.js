// src/middleware/rateLimit.js
import crypto from "node:crypto";
import { createRedisRateLimiter } from "../services/rateLimitService.js";

function hashRateLimitIdentity(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

export const loginLimiter = createRedisRateLimiter({
  scope: "auth-login-ip",
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 attempts per window per IP
  message: { error: "Too many login attempts, please try again later" },
  keyBuilder: (req) => req.ip || "unknown",
});
export const authLimiter = createRedisRateLimiter({
  scope: "auth-generic-ip",
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: "Too many requests, please try again later" },
  keyBuilder: (req) => req.ip || "unknown",
});

export const emailCodeLimiter = createRedisRateLimiter({
  scope: "auth-email-ip",
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  message: { error: "Too many email requests, please try again later" },
  keyBuilder: (req) => req.ip || "unknown",
});

export const contactIpLimiter = createRedisRateLimiter({
  scope: "contact-ip",
  windowMs: 15 * 60 * 1000,
  limit: 8,
  message: { error: "Too many contact requests, please try again later" },
  keyBuilder: (req) => req.ip || "unknown",
});

export const contactEmailLimiter = createRedisRateLimiter({
  scope: "contact-email",
  windowMs: 60 * 60 * 1000,
  limit: 4,
  message: { error: "Too many contact requests for this email, please try again later" },
  keyBuilder: (req) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    return email ? hashRateLimitIdentity(email) : req.ip || "unknown";
  },
});
