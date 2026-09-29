// src/services/paymentReconciliationService.js
import crypto from "crypto";
import { Prisma } from "@prisma/client";
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

export function hashWebhookSignature(signature) {
  if (typeof signature !== "string") return null;

  const normalized = signature.trim();
  if (!normalized) return null;

  return `sha256:${crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")}`;
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

function normalizeAdminDate(value, endOfDay = false) {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  // Date inputs arrive as YYYY-MM-DD. Treat the end date as inclusive while
  // keeping the database query half-open, which avoids timezone edge cases.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
    : new Date(raw);

  return Number.isNaN(date.getTime()) ? null : date;
}

function buildAdminOrderWhere({
  status = "all",
  search = "",
  packageId = null,
  from = "",
  to = "",
} = {}) {
  const where = {};

  if (["paid", "pending", "failed"].includes(status)) {
    where.status = status;
  }

  if (packageId) {
    where.packageId = Number(packageId);
  }

  const fromDate = normalizeAdminDate(from);
  const toDate = normalizeAdminDate(to, true);
  if (fromDate || toDate) {
    where.createdAt = {
      ...(fromDate ? { gte: fromDate } : {}),
      ...(toDate ? { lte: toDate } : {}),
    };
  }

  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch) {
    const searchConditions = [
      { id: { contains: normalizedSearch, mode: "insensitive" } },
      { customerEmail: { contains: normalizedSearch, mode: "insensitive" } },
      { customerPhone: { contains: normalizedSearch, mode: "insensitive" } },
      { user: { name: { contains: normalizedSearch, mode: "insensitive" } } },
      { user: { email: { contains: normalizedSearch, mode: "insensitive" } } },
      { package: { title: { contains: normalizedSearch, mode: "insensitive" } } },
    ];

    const transactionId = Number(normalizedSearch);
    if (Number.isInteger(transactionId) && transactionId > 0) {
      searchConditions.push({ paymobTxnId: transactionId });
    }

    where.OR = searchConditions;
  }

  return where;
}

function serializeWebhookEvent(row) {
  return {
    id: Number(row.id),
    eventKey: row.event_key,
    transactionId: row.transaction_id,
    eventStatus: row.event_status,
    resolution: row.resolution,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    updatedAt: row.updated_at,
  };
}

async function getLatestWebhookEvents(orderIds) {
  if (!orderIds.length) return new Map();

  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (order_id)
      id, order_id, event_key, transaction_id, event_status, resolution,
      attempt_count, last_error, received_at, processed_at, updated_at
    FROM payment_webhook_events
    WHERE provider = ${PROVIDER_PAYMOB}
      AND order_id IN (${Prisma.join(orderIds)})
    ORDER BY order_id, received_at DESC, id DESC
  `;

  return new Map(
    rows.map((row) => [String(row.order_id), serializeWebhookEvent(row)])
  );
}

function summarizeOrder(order, latestWebhook) {
  return {
    id: order.id,
    status: order.status,
    amountCents: Number(order.amountCents || 0),
    currency: order.currency || "EGP",
    psp: order.psp || PROVIDER_PAYMOB,
    paymobTxnId: order.paymobTxnId == null ? null : Number(order.paymobTxnId),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    customer: {
      id: order.user?.id ?? order.userId ?? null,
      name: order.user?.name || "Unknown customer",
      email: order.customerEmail || order.user?.email || null,
      phone: order.customerPhone || order.user?.phone || null,
    },
    package: order.package
      ? { id: order.package.id, title: order.package.title }
      : order.packageId
        ? { id: order.packageId, title: "Package unavailable" }
        : null,
    discountCode: order.discountCode?.code || null,
    latestWebhook,
  };
}

/**
 * Admin-facing payment operations data. This intentionally uses the same
 * Order records that control fulfillment, while joining the reconciliation
 * table only for provider/webhook health and diagnostics.
 */
export async function getPaymobAdminPayments({
  status = "all",
  search = "",
  packageId = null,
  from = "",
  to = "",
  limit = 25,
  offset = 0,
} = {}) {
  await ensureWebhookEventsTable();

  const where = buildAdminOrderWhere({ status, search, packageId, from, to });
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const statusNames = ["paid", "pending", "failed"];
  const [orders, total, statusAggregates, webhookSummary] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: safeOffset,
      take: safeLimit,
      select: {
        id: true,
        amountCents: true,
        currency: true,
        status: true,
        psp: true,
        paymobTxnId: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        packageId: true,
        customerEmail: true,
        customerPhone: true,
        discountCode: { select: { code: true } },
        user: { select: { id: true, name: true, email: true, phone: true } },
        package: { select: { id: true, title: true } },
      },
    }),
    prisma.order.count({ where }),
    Promise.all(
      statusNames.map(async (statusName) => {
        const aggregate = await prisma.order.aggregate({
          where: { ...where, status: statusName },
          _count: { _all: true },
          _sum: { amountCents: true },
        });
        return [statusName, {
          count: aggregate._count._all,
          amountCents: Number(aggregate._sum.amountCents || 0),
        }];
      })
    ),
    getPaymobWebhookReconciliationSummary(),
  ]);

  const latestWebhooks = await getLatestWebhookEvents(orders.map((order) => order.id));
  const aggregates = Object.fromEntries(statusAggregates);
  const paidCount = aggregates.paid?.count || 0;
  const conversionRate = total > 0 ? Number(((paidCount / total) * 100).toFixed(1)) : 0;

  return {
    items: orders.map((order) =>
      summarizeOrder(order, latestWebhooks.get(String(order.id)) || null)
    ),
    summary: {
      totalOrders: total,
      paidOrders: paidCount,
      pendingOrders: aggregates.pending?.count || 0,
      failedOrders: aggregates.failed?.count || 0,
      paidAmountCents: aggregates.paid?.amountCents || 0,
      pendingAmountCents: aggregates.pending?.amountCents || 0,
      failedAmountCents: aggregates.failed?.amountCents || 0,
      conversionRate,
      webhook: webhookSummary,
    },
    pagination: {
      limit: safeLimit,
      offset: safeOffset,
      total,
      hasMore: safeOffset + orders.length < total,
    },
  };
}

export async function getPaymobAdminPaymentDetail(orderId) {
  await ensureWebhookEventsTable();

  const order = await prisma.order.findUnique({
    where: { id: String(orderId) },
    select: {
      id: true,
      amountCents: true,
      currency: true,
      status: true,
      psp: true,
      pspOrderId: true,
      paymobTxnId: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      packageId: true,
      customerEmail: true,
      customerPhone: true,
      pricingSnapshot: true,
      discountCode: { select: { code: true, percentage: true } },
      user: { select: { id: true, name: true, email: true, phone: true } },
      package: { select: { id: true, title: true } },
      userPackage: {
        select: { id: true, title: true, sessionsTotal: true, status: true, createdAt: true },
      },
    },
  });

  if (!order) return null;

  const events = await prisma.$queryRaw`
    SELECT id, order_id, event_key, transaction_id, event_status, resolution,
           attempt_count, last_error, received_at, processed_at, updated_at
    FROM payment_webhook_events
    WHERE provider = ${PROVIDER_PAYMOB}
      AND order_id = ${String(order.id)}
    ORDER BY received_at DESC, id DESC
  `;

  return {
    ...summarizeOrder(order, events[0] ? serializeWebhookEvent(events[0]) : null),
    pspOrderId: order.pspOrderId == null ? null : Number(order.pspOrderId),
    pricingSnapshot: order.pricingSnapshot,
    discount: order.discountCode,
    fulfillment: order.userPackage,
    webhookEvents: events.map(serializeWebhookEvent),
  };
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
  const signatureHash = hashWebhookSignature(signature);

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
      ${signatureHash},
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
      signatureHash,
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
      signatureHash,
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

export async function getPaymobWebhookReconciliationSummary() {
  await ensureWebhookEventsTable();

  const [statusRows, recentFailures, latestEventRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT event_status, COUNT(*)::int AS count
      FROM payment_webhook_events
      GROUP BY event_status
      ORDER BY event_status
    `,
    prisma.$queryRaw`
      SELECT id, provider, event_key, order_id, transaction_id, last_error,
             attempt_count, received_at, updated_at
      FROM payment_webhook_events
      WHERE event_status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 25
    `,
    prisma.$queryRaw`
      SELECT received_at
      FROM payment_webhook_events
      WHERE provider = ${PROVIDER_PAYMOB}
      ORDER BY received_at DESC
      LIMIT 1
    `,
  ]);

  return {
    statuses: Object.fromEntries(
      statusRows.map((row) => [String(row.event_status), Number(row.count || 0)])
    ),
    recentFailures,
    lastReceivedAt: latestEventRows[0]?.received_at || null,
  };
}
