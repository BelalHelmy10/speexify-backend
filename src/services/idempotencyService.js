// src/services/idempotencyService.js
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const IDEMPOTENCY_HEADER = "x-idempotency-key";
const MAX_KEY_LENGTH = 128;

let ensureTablePromise = null;

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",");
  return `{${body}}`;
}

function hashPayload(payload) {
  const serialized = stableStringify(payload ?? {});
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

async function ensureIdempotencyTable() {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS api_idempotency_keys (
        id BIGSERIAL PRIMARY KEY,
        actor_id INTEGER NOT NULL,
        scope TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        response_status INTEGER,
        response_body JSONB,
        resource_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (actor_id, scope, idem_key)
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS api_idempotency_keys_created_at_idx
      ON api_idempotency_keys(created_at)
    `);
  })();

  try {
    await ensureTablePromise;
  } catch (err) {
    ensureTablePromise = null;
    throw err;
  }
}

export function getIdempotencyKeyFromRequest(req) {
  const raw = req.get(IDEMPOTENCY_HEADER);
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_KEY_LENGTH);
}

export async function beginIdempotentRequest({
  actorId,
  scope,
  key,
  payload,
}) {
  if (!key) {
    return { enabled: false };
  }

  await ensureIdempotencyTable();

  const requestHash = hashPayload(payload);

  const insertedRows = await prisma.$queryRaw`
    INSERT INTO api_idempotency_keys (
      actor_id, scope, idem_key, request_hash, status, created_at, updated_at
    )
    VALUES (${Number(actorId)}, ${scope}, ${key}, ${requestHash}, 'processing', NOW(), NOW())
    ON CONFLICT (actor_id, scope, idem_key) DO NOTHING
    RETURNING id
  `;

  if (insertedRows.length > 0) {
    return {
      enabled: true,
      state: "started",
      recordId: Number(insertedRows[0].id),
    };
  }

  const existingRows = await prisma.$queryRaw`
    SELECT id, request_hash, status, response_status, response_body
    FROM api_idempotency_keys
    WHERE actor_id = ${Number(actorId)}
      AND scope = ${scope}
      AND idem_key = ${key}
    LIMIT 1
  `;

  if (!existingRows.length) {
    return {
      enabled: true,
      state: "error",
      statusCode: 500,
      responseBody: { error: "idempotency_lookup_failed" },
    };
  }

  const row = existingRows[0];
  if (row.request_hash !== requestHash) {
    return {
      enabled: true,
      state: "conflict",
      statusCode: 409,
      responseBody: {
        error: "idempotency_key_reused_with_different_payload",
      },
    };
  }

  if (row.status === "completed") {
    return {
      enabled: true,
      state: "replay",
      statusCode: Number(row.response_status || 200),
      responseBody: row.response_body || { ok: true, replayed: true },
    };
  }

  return {
    enabled: true,
    state: "in_progress",
    statusCode: 409,
    responseBody: { error: "idempotency_request_in_progress" },
  };
}

export async function completeIdempotentRequest(
  recordId,
  { statusCode = 200, responseBody = null, resourceId = null } = {}
) {
  if (!recordId) return;
  await ensureIdempotencyTable();

  const serializedBody = JSON.stringify(responseBody ?? {});

  await prisma.$executeRawUnsafe(
    `
      UPDATE api_idempotency_keys
      SET status = 'completed',
          response_status = $1,
          response_body = CAST($2 AS jsonb),
          resource_id = $3,
          updated_at = NOW()
      WHERE id = $4
    `,
    Number(statusCode),
    serializedBody,
    resourceId == null ? null : Number(resourceId),
    Number(recordId)
  );
}

export async function abandonIdempotentRequest(recordId) {
  if (!recordId) return;
  await ensureIdempotencyTable();

  try {
    await prisma.$executeRaw`
      DELETE FROM api_idempotency_keys
      WHERE id = ${Number(recordId)}
        AND status = 'processing'
    `;
  } catch (err) {
    logger.error(
      { err, recordId: Number(recordId) },
      "idempotency abandon failed"
    );
  }
}
