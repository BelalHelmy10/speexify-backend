import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendRoot = fileURLToPath(new URL("..", import.meta.url));
const sessionProbeScript = `
  import { sessionStoreInfo } from "./src/middleware/session.js";
  console.log("SESSION_STORE:" + JSON.stringify(sessionStoreInfo));
`;

function probeSessionStore(envOverrides) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", sessionProbeScript],
    {
      cwd: backendRoot,
      env: {
        ...process.env,
        LOG_LEVEL: "fatal",
        ...envOverrides,
      },
      encoding: "utf8",
    }
  );

  const markerLine = String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("SESSION_STORE:"));

  return {
    ...result,
    store: markerLine
      ? JSON.parse(markerLine.slice("SESSION_STORE:".length))
      : null,
  };
}

test("session store stays in memory mode during tests even with Redis configured", () => {
  const result = probeSessionStore({
    NODE_ENV: "test",
    REDIS_URL: "redis://127.0.0.1:6399",
    SESSION_REDIS_STRICT: "true",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.store?.mode, "memory");
  assert.equal(result.store?.reason, "forced_memory_mode");
});

test("session store falls back to memory when Redis is unavailable", () => {
  const result = probeSessionStore({
    NODE_ENV: "development",
    REDIS_URL: "redis://127.0.0.1:6399",
    SESSION_REDIS_CONNECT_TIMEOUT_MS: "200",
    SESSION_REDIS_STRICT: "false",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.store?.mode, "memory");
  assert.equal(result.store?.reason, "redis_connect_failed");
});

test("strict mode fails startup when Redis is unavailable", () => {
  const result = probeSessionStore({
    NODE_ENV: "development",
    REDIS_URL: "redis://127.0.0.1:6399",
    SESSION_REDIS_CONNECT_TIMEOUT_MS: "200",
    SESSION_REDIS_STRICT: "true",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /Redis session store initialization failed in strict mode/
  );
});
