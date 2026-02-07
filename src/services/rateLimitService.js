// src/services/rateLimitService.js
import { createClient } from "redis";
import { REDIS_URL } from "../config/env.js";
import { logger } from "../lib/logger.js";

const KEY_PREFIX = "speexify:ratelimit:";

let redisClient = null;
let connectPromise = null;
const memoryFallbackBuckets = new Map();

function normalizeWindowMs(windowMs) {
  const value = Number(windowMs);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("windowMs must be a positive number");
  }
  return Math.floor(value);
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("limit must be a positive number");
  }
  return Math.floor(value);
}

function normalizeKey(key) {
  const value = String(key || "").trim();
  if (!value) throw new Error("key is required");
  return `${KEY_PREFIX}${value}`;
}

async function getRedisClient() {
  if (!REDIS_URL) return null;

  if (!redisClient) {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        tls: REDIS_URL.startsWith("rediss://"),
        rejectUnauthorized: true,
      },
    });

    redisClient.on("error", (err) => {
      logger.error({ err }, "[rate-limit] redis client error");
    });
  }

  if (redisClient.isOpen) {
    return redisClient;
  }

  if (!connectPromise) {
    connectPromise = redisClient
      .connect()
      .then(() => {
        connectPromise = null;
        return true;
      })
      .catch((err) => {
        logger.error({ err }, "[rate-limit] redis connect failed");
        connectPromise = null;
        return null;
      });
  }

  await connectPromise;
  return redisClient.isOpen ? redisClient : null;
}

function consumeInMemory({ key, limit, windowMs }) {
  const now = Date.now();

  // Lazy cleanup of stale buckets to keep memory bounded.
  for (const [bucketKey, bucket] of memoryFallbackBuckets.entries()) {
    if (bucket.resetAt <= now) {
      memoryFallbackBuckets.delete(bucketKey);
    }
  }

  const existing = memoryFallbackBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    const next = { count: 1, resetAt };
    memoryFallbackBuckets.set(key, next);
    return {
      allowed: true,
      current: 1,
      remaining: Math.max(0, limit - 1),
      resetMs: windowMs,
      source: "memory_fallback",
    };
  }

  existing.count += 1;
  const resetMs = Math.max(0, existing.resetAt - now);
  return {
    allowed: existing.count <= limit,
    current: existing.count,
    remaining: Math.max(0, limit - existing.count),
    resetMs,
    source: "memory_fallback",
  };
}

export async function consumeRateLimit({ key, limit, windowMs }) {
  const normalizedKey = normalizeKey(key);
  const normalizedLimit = normalizeLimit(limit);
  const normalizedWindowMs = normalizeWindowMs(windowMs);

  try {
    const client = await getRedisClient();
    if (!client) {
      return consumeInMemory({
        key: normalizedKey,
        limit: normalizedLimit,
        windowMs: normalizedWindowMs,
      });
    }

    const result = await client.eval(
      `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      end

      local ttl = redis.call('PTTL', KEYS[1])
      if ttl < 0 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
        ttl = tonumber(ARGV[1])
      end

      return { current, ttl }
      `,
      {
        keys: [normalizedKey],
        arguments: [String(normalizedWindowMs)],
      }
    );

    const current = Number(result?.[0] || 0);
    const ttlMs = Number(result?.[1] || normalizedWindowMs);

    return {
      allowed: current <= normalizedLimit,
      current,
      remaining: Math.max(0, normalizedLimit - current),
      resetMs: Math.max(0, ttlMs),
      source: "redis",
    };
  } catch (err) {
    logger.error(
      { err, key: normalizedKey },
      "[rate-limit] redis rate-limit failed, using memory fallback"
    );
    return consumeInMemory({
      key: normalizedKey,
      limit: normalizedLimit,
      windowMs: normalizedWindowMs,
    });
  }
}

export function createRedisRateLimiter({
  scope,
  limit,
  windowMs,
  statusCode = 429,
  message = { error: "Too many requests, please try again later" },
  keyBuilder = (req) => req.ip || "unknown",
}) {
  const normalizedScope = String(scope || "").trim();
  if (!normalizedScope) {
    throw new Error("createRedisRateLimiter: scope is required");
  }

  return async function redisRateLimiter(req, res, next) {
    try {
      const identity = String(
        typeof keyBuilder === "function" ? keyBuilder(req) : "unknown"
      )
        .trim()
        .slice(0, 180);

      const result = await consumeRateLimit({
        key: `${normalizedScope}:${identity || "unknown"}`,
        limit,
        windowMs,
      });

      const resetSeconds = Math.max(1, Math.ceil(result.resetMs / 1000));
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("X-RateLimit-Reset", String(resetSeconds));

      if (!result.allowed) {
        res.setHeader("Retry-After", String(resetSeconds));
        return res.status(statusCode).json(message);
      }

      return next();
    } catch (err) {
      logger.error({ err, scope: normalizedScope }, "[rate-limit] middleware error");
      // Fail-open to avoid taking down auth/support if limiter infrastructure fails.
      return next();
    }
  };
}
