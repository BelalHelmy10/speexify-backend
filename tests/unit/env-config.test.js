import test from "node:test";
import assert from "node:assert/strict";

const ENV_MODULE_URL = new URL("../../src/config/env.js", import.meta.url);
let importCounter = 0;

async function importFreshEnv(envPatch) {
  const previous = {};

  for (const key of Object.keys(envPatch)) {
    previous[key] = process.env[key];
    const nextValue = envPatch[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(nextValue);
    }
  }

  try {
    importCounter += 1;
    return await import(
      `${ENV_MODULE_URL.href}?case=${Date.now()}-${importCounter}`
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("production env rejects missing SESSION_SECRET", async () => {
  await assert.rejects(
    () =>
      importFreshEnv({
        NODE_ENV: "production",
        SESSION_SECRET: undefined,
        REDIS_URL: "redis://localhost:6379",
      }),
    /SESSION_SECRET must be set in production/
  );
});

test("production env rejects insecure SESSION_SECRET values", async () => {
  await assert.rejects(
    () =>
      importFreshEnv({
        NODE_ENV: "production",
        SESSION_SECRET: "dev-secret-change-me",
        REDIS_URL: "redis://localhost:6379",
      }),
    /SESSION_SECRET must not use an insecure development secret/
  );
});

test("production env requires sufficiently long secrets", async () => {
  await assert.rejects(
    () =>
      importFreshEnv({
        NODE_ENV: "production",
        SESSION_SECRET: "short-production-secret",
        REDIS_URL: "redis://localhost:6379",
      }),
    /SESSION_SECRET must be at least 32 characters/
  );
});

test("production env falls back token/feed secrets to a strong session secret", async () => {
  const sessionSecret = "speexify-production-session-secret-0001";
  const env = await importFreshEnv({
    NODE_ENV: "production",
    SESSION_SECRET: sessionSecret,
    OBS_METRICS_TOKEN: "speexify-production-metrics-token-0001",
    WS_AUTH_TOKEN_SECRET: undefined,
    CALENDAR_FEED_SECRET: undefined,
    REDIS_URL: "redis://localhost:6379",
  });

  assert.equal(env.SESSION_SECRET, sessionSecret);
  assert.equal(env.WS_AUTH_TOKEN_SECRET, sessionSecret);
  assert.equal(env.CALENDAR_FEED_SECRET, sessionSecret);
});

test("production env rejects missing OBS_METRICS_TOKEN", async () => {
  await assert.rejects(
    () =>
      importFreshEnv({
        NODE_ENV: "production",
        SESSION_SECRET: "speexify-production-session-secret-0003",
        OBS_METRICS_TOKEN: undefined,
        REDIS_URL: "redis://localhost:6379",
      }),
    /OBS_METRICS_TOKEN must be set in production/
  );
});

test("production env rejects insecure dedicated token secrets", async () => {
  await assert.rejects(
    () =>
      importFreshEnv({
        NODE_ENV: "production",
        SESSION_SECRET: "speexify-production-session-secret-0002",
        WS_AUTH_TOKEN_SECRET: "change-me",
        REDIS_URL: "redis://localhost:6379",
      }),
    /WS_AUTH_TOKEN_SECRET must not use an insecure development secret/
  );
});
