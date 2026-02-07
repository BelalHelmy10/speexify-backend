// src/middleware/rateLimit.js
import { createRedisRateLimiter } from "../services/rateLimitService.js";

export const loginLimiter = createRedisRateLimiter({
  scope: "auth-login-ip",
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 attempts per window per IP
  message: { error: "Too many login attempts, please try again later" },
  keyBuilder: (req) => req.ip || "unknown",
});
