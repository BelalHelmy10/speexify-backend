// src/middleware/session.js
import session from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";
import {
  SESSION_SECRET,
  REDIS_URL,
  SESSION_FORCE_MEMORY,
  SESSION_REDIS_STRICT,
  SESSION_REDIS_CONNECT_TIMEOUT_MS,
} from "../config/env.js";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "../config/session.js";
import { logger } from "../lib/logger.js";

const MemoryStore = session.MemoryStore;

if (!SESSION_SECRET) {
  logger.warn(
    "[session] SESSION_SECRET is missing. Falling back to an insecure dev secret."
  );
}

// Create Redis client/store once (module singleton).
let redisClient = null;
let store = new MemoryStore();
let redisReconnectEnabled = false;

export let sessionStoreInfo = {
  mode: "memory",
  reason: "startup_default",
};

function setMemoryStore(reason, logLevel = "warn") {
  store = new MemoryStore();
  sessionStoreInfo = { mode: "memory", reason };

  const message = `[session] Using in-memory session store (${reason})`;
  if (logLevel === "info") {
    logger.info(message);
    return;
  }
  if (logLevel === "error") {
    logger.error(message);
    return;
  }
  logger.warn(message);
}

function createRedisClient() {
  const client = createClient({
    url: REDIS_URL,
    socket: {
      tls: REDIS_URL.startsWith("rediss://"),
      rejectUnauthorized: true,
      connectTimeout: SESSION_REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy(retries) {
        if (!redisReconnectEnabled) return false;
        return Math.min(retries * 200, 2000);
      },
    },
  });

  client.on("error", (err) => {
    logger.error({ err }, "[session] Redis client error");
  });

  client.on("reconnecting", () => {
    logger.warn("[session] Redis client reconnecting");
  });

  return client;
}

async function destroyRedisClient(client) {
  if (!client) return;
  try {
    if (client.isOpen && typeof client.quit === "function") {
      await client.quit();
      return;
    }
  } catch (err) {
    logger.warn({ err }, "[session] Failed to quit Redis client cleanly");
  }

  try {
    if (typeof client.destroy === "function") {
      client.destroy();
      return;
    }
  } catch (err) {
    logger.warn({ err }, "[session] Failed to destroy Redis client");
  }

  try {
    if (typeof client.disconnect === "function") {
      client.disconnect();
    }
  } catch (err) {
    logger.warn({ err }, "[session] Failed to disconnect Redis client");
  }
}

async function initializeSessionStore() {
  if (SESSION_FORCE_MEMORY) {
    setMemoryStore("forced_memory_mode", "info");
    return;
  }

  if (!REDIS_URL) {
    if (SESSION_REDIS_STRICT) {
      throw new Error(
        "SESSION_REDIS_STRICT=true requires REDIS_URL to be configured"
      );
    }
    setMemoryStore("redis_url_missing");
    return;
  }

  redisClient = createRedisClient();

  try {
    await redisClient.connect();
    redisReconnectEnabled = true;
    store = new RedisStore({
      client: redisClient,
      prefix: "speexify:sess:",
    });
    sessionStoreInfo = { mode: "redis", reason: "connected" };
    logger.info("[session] Using Redis session store");
  } catch (err) {
    redisReconnectEnabled = false;
    await destroyRedisClient(redisClient);
    redisClient = null;

    if (SESSION_REDIS_STRICT) {
      throw new Error(
        `Redis session store initialization failed in strict mode: ${err.message}`
      );
    }

    logger.error(
      { err },
      "[session] Redis session store unavailable, falling back to memory"
    );
    setMemoryStore("redis_connect_failed", "error");
  }
}
await initializeSessionStore();

export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  store,
  secret: SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    ...sessionCookieOptions,
  },
});
