// src/middleware/rateLimit.js
import { createRedisRateLimiter } from "../services/rateLimitService.js";

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
