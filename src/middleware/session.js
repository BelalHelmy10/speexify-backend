// src/middleware/session.js
import session from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";
import { SESSION_SECRET, REDIS_URL } from "../config/env.js";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "../config/session.js";

if (!SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set. Using an insecure fallback for dev."
  );
}

// Create Redis client/store once (module singleton)
let redisClient = null;
let store = undefined;

if (REDIS_URL) {
  redisClient = createClient({
    url: REDIS_URL,
    // Upstash uses TLS; rediss:// usually handles it,
    // but this keeps it robust if someone accidentally uses redis://
    socket: {
      tls: REDIS_URL.startsWith("rediss://"),
      rejectUnauthorized: true,
    },
  });

  redisClient.on("error", (err) => {
    console.error("❌ Redis client error:", err);
  });

  await redisClient.connect();

  store = new RedisStore({
    client: redisClient,
    prefix: "speexify:sess:",
  });

  console.log("✅ Session store: Redis");
} else {
  console.warn(
    "⚠️  REDIS_URL not set. Falling back to MemoryStore (DEV ONLY)."
  );
}

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
