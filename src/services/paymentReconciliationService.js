// src/services/paymentReconciliationService.js
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const PROVIDER_PAYMOB = "paymob";
const PROCESSING_STALE_MS = 2 * 60 * 1000;

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

async function ensureWebhookEventsTable() {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS payment_webhook_events (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        event_key TEXT NOT NULL,
        order_id TEXT,
        transaction_id TEXT,
        event_status TEXT NOT NULL DEFAULT 'processing',
        attempt_count INTEGER NOT NULL DEFAULT 1,
        resolution TEXT,
        last_error TEXT,
        request_hash TEXT NOT NULL,
        signature TEXT,
        payload JSONB,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (provider, event_key)
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS payment_webhook_events_order_idx
      ON payment_webhook_events(order_id)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS payment_webhook_events_txn_idx
      ON payment_webhook_events(transaction_id)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS payment_webhook_events_status_idx
      ON payment_webhook_events(event_status, updated_at)
    `);
  })();

  try {
    await ensureTablePromise;
  } catch (err) {
    ensureTablePromise = null;
    throw err;
  }
}

export function buildPaymobEventKey(txn = {}) {
  return [
    `txn:${txn.transactionId || "none"}`,
    `ref:${txn.specialReference || txn.merchantOrderId || "none"}`,
    `ok:${txn.success ? 1 : 0}`,
    `pending:${txn.pending ? 1 : 0}`,
    `error:${txn.errorOccurred ? 1 : 0}`,
    `refunded:${txn.isRefunded ? 1 : 0}`,
    `voided:${txn.isVoided ? 1 : 0}`,
    `amount:${txn.amountCents || "none"}`,
    `currency:${txn.currency || "none"}`,
  ].join("|");
}

export async function beginPaymobWebhookReconciliation({
  eventKey,
  orderId = null,
  transactionId = null,
  payload = null,
  signature = null,
}) {
  await ensureWebhookEventsTable();

  const requestHash = hashPayload(payload);

  const insertedRows = await prisma.$queryRaw`
    INSERT INTO payment_webhook_events (
      provider,
      event_key,
      order_id,
      transaction_id,
      event_status,
      attempt_count,
      request_hash,
      signature,
      payload,
      received_at,
      updated_at
    )
    VALUES (
      ${PROVIDER_PAYMOB},
      ${eventKey},
      ${orderId},
      ${transactionId},
      'processing',
      1,
      ${requestHash},
      ${signature},
      ${payload ? JSON.stringify(payload) : null}::jsonb,
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, event_key) DO NOTHING
    RETURNING id, attempt_count
  `;

  if (insertedRows.length) {
    return {
      state: "started",
      recordId: Number(insertedRows[0].id),
      attemptCount: Number(insertedRows[0].attempt_count || 1),
      requestHash,
    };
  }

  const existingRows = await prisma.$queryRaw`
    SELECT id, event_status, attempt_count, request_hash, updated_at
    FROM payment_webhook_events
    WHERE provider = ${PROVIDER_PAYMOB}
      AND event_key = ${eventKey}
    LIMIT 1
  `;

  if (!existingRows.length) {
    return {
      state: "error",
      error: "webhook_event_lookup_failed",
    };
  }

  const existing = existingRows[0];
  const existingStatus = String(existing.event_status || "");

  if (existing.request_hash !== requestHash) {
    return {
      state: "conflict",
      recordId: Number(existing.id),
      attemptCount: Number(existing.attempt_count || 1),
      error: "event_key_reused_with_different_payload",
    };
  }

  if (existingStatus === "processed" || existingStatus === "ignored") {
    return {
      state: "replay",
      recordId: Number(existing.id),
      attemptCount: Number(existing.attempt_count || 1),
    };
  }

  const updatedAt = new Date(existing.updated_at);
  if (
    existingStatus === "processing" &&
    Date.now() - updatedAt.getTime() < PROCESSING_STALE_MS
  ) {
    return {
      state: "in_progress",
      recordId: Number(existing.id),
      attemptCount: Number(existing.attempt_count || 1),
    };
  }

  const claimedRows = await prisma.$queryRaw`
    UPDATE payment_webhook_events
    SET event_status = 'processing',
        attempt_count = attempt_count + 1,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${Number(existing.id)}
    RETURNING id, attempt_count
  `;

  if (!claimedRows.length) {
    return {
      state: "in_progress",
      recordId: Number(existing.id),
      attemptCount: Number(existing.attempt_count || 1),
    };
  }

  return {
    state: "retrying",
    recordId: Number(claimedRows[0].id),
    attemptCount: Number(claimedRows[0].attempt_count || 1),
    requestHash,
  };
}

export async function markWebhookEventProcessed(
  recordId,
  { orderId = null, transactionId = null, resolution = "processed" } = {}
) {
  if (!recordId) return;
  await ensureWebhookEventsTable();

  await prisma.$executeRaw`
    UPDATE payment_webhook_events
    SET event_status = 'processed',
        order_id = COALESCE(${orderId}, order_id),
        transaction_id = COALESCE(${transactionId}, transaction_id),
        resolution = ${resolution},
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${Number(recordId)}
  `;
}

export async function markWebhookEventIgnored(
  recordId,
  { orderId = null, transactionId = null, reason = "ignored" } = {}
) {
  if (!recordId) return;
  await ensureWebhookEventsTable();

  await prisma.$executeRaw`
    UPDATE payment_webhook_events
    SET event_status = 'ignored',
        order_id = COALESCE(${orderId}, order_id),
        transaction_id = COALESCE(${transactionId}, transaction_id),
        resolution = ${reason},
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${Number(recordId)}
  `;
}

export async function markWebhookEventFailed(
  recordId,
  {
    orderId = null,
    transactionId = null,
    error = "webhook_processing_failed",
  } = {}
) {
  if (!recordId) return;
  await ensureWebhookEventsTable();

  const lastError = String(error || "webhook_processing_failed").slice(0, 1000);

  try {
    await prisma.$executeRaw`
      UPDATE payment_webhook_events
      SET event_status = 'failed',
          order_id = COALESCE(${orderId}, order_id),
          transaction_id = COALESCE(${transactionId}, transaction_id),
          last_error = ${lastError},
          updated_at = NOW()
      WHERE id = ${Number(recordId)}
    `;
  } catch (err) {
    logger.error(
      { err, recordId: Number(recordId), orderId, transactionId },
      "Failed to mark webhook event as failed"
    );
  }
}

