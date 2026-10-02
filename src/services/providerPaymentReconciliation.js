import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { PAYMOB_SECRET_KEY } from "../config/env.js";
import { inquirePaymobTransaction, inquirePaymobTransactionById } from "./paymobService.js";
import { markOrderPaid } from "./orderService.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const RECONCILIATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ORDER_AGE_MS = 30_000;

export function expectedPaymobLiveMode(secretKey = PAYMOB_SECRET_KEY) {
  const match = String(secretKey || "").match(/(?:^|_)sk_(live|test)_/i);
  if (!match) throw new Error("Cannot determine Paymob live/test mode from secret key");
  return match[1].toLowerCase() === "live";
}

/** A provider inquiry can grant a package only when every payment detail matches. */
export function verifyPaymobPaymentForOrder(order, transaction, expectedLive) {
  if (!transaction) return { confirmed: false, reason: "transaction_not_found" };
  if (!Number.isSafeInteger(Number(transaction.id)) || Number(transaction.id) <= 0) {
    return { confirmed: false, reason: "invalid_transaction_id" };
  }
  if (transaction.order?.merchant_order_id !== order.id) {
    return { confirmed: false, reason: "reference_mismatch" };
  }
  if (Number(transaction.amount_cents) !== Number(order.amountCents) ||
      String(transaction.currency || "").toUpperCase() !== String(order.currency || "").toUpperCase()) {
    return { confirmed: false, reason: "amount_or_currency_mismatch" };
  }
  if (transaction.is_live !== expectedLive) {
    return { confirmed: false, reason: "payment_mode_mismatch" };
  }
  if (transaction.is_refunded !== false || transaction.is_voided !== false ||
      Number(transaction.refunded_amount_cents || 0) !== 0) {
    return { confirmed: false, reason: "payment_refunded_or_voided" };
  }
  if (transaction.pending === true) return { confirmed: false, reason: "payment_pending" };
  if (transaction.pending === false && transaction.success === false) {
    return { confirmed: false, reason: "payment_failed" };
  }
  if (transaction.pending !== false || transaction.success !== true ||
      transaction.error_occured !== false || transaction.is_auth !== false) {
    return { confirmed: false, reason: "payment_not_completed" };
  }
  if (transaction.order?.paid_amount_cents != null &&
      Number(transaction.order.paid_amount_cents) < Number(order.amountCents)) {
    return { confirmed: false, reason: "partial_payment" };
  }
  return { confirmed: true, transactionId: Number(transaction.id) };
}

export async function reconcileOrderFromPaymob(orderId, {
  db = prisma,
  inquire = inquirePaymobTransaction,
  inquireById = inquirePaymobTransactionById,
  markPaid = markOrderPaid,
  expectedLive = expectedPaymobLiveMode(),
  transactionId = null,
} = {}) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { userPackage: true },
  });
  if (!order) return { status: "order_not_found" };
  if (order.status === "paid" && order.userPackage) return { status: "already_fulfilled" };
  if (!order.userId || !order.packageId) return { status: "incomplete_order" };

  const transaction = transactionId == null
    ? await inquire(order.id)
    : await inquireById(transactionId);
  const verification = verifyPaymobPaymentForOrder(order, transaction, expectedLive);
  if (!verification.confirmed) {
    if (transaction?.success === true) {
      logger.error({ orderId, reason: verification.reason }, "Provider payment could not be reconciled");
    }
    return { status: verification.reason };
  }

  const result = await markPaid(order.id, verification.transactionId);
  logger.info({ orderId, transactionId: verification.transactionId, userPackageId: result.userPackage?.id },
    "Provider inquiry fulfilled paid order");
  return { status: "paid", transactionId: verification.transactionId, userPackageId: result.userPackage?.id };
}

const pollReconciliations = new Map();

/** Coalesce frequent status polls from the same checkout into one provider inquiry. */
export function reconcileOrderFromPaymobForStatusPoll(orderId) {
  const now = Date.now();
  const cached = pollReconciliations.get(orderId);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = reconcileOrderFromPaymob(orderId);
  pollReconciliations.set(orderId, { promise, expiresAt: now + 5000 });
  if (pollReconciliations.size > 500) {
    const oldestKey = pollReconciliations.keys().next().value;
    pollReconciliations.delete(oldestKey);
  }
  return promise;
}

/** Sweep recent unpaid orders so fulfillment works even when a webhook is missed. */
export async function reconcilePendingPaymentsBatch({
  db = prisma,
  reconcile = reconcileOrderFromPaymob,
  cursor = null,
  limit = DEFAULT_BATCH_SIZE,
  now = new Date(),
} = {}) {
  const windowStart = new Date(now.getTime() - RECONCILIATION_WINDOW_MS);
  const matureBefore = new Date(now.getTime() - MIN_ORDER_AGE_MS);
  const orders = await db.order.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      updatedAt: { gte: windowStart, lte: matureBefore },
      ...(cursor ? { OR: [
        { updatedAt: { gt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
      ] } : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, updatedAt: true },
  });

  let fulfilled = 0;
  let errors = 0;
  for (const order of orders) {
    try {
      const result = await reconcile(order.id);
      if (result.status === "paid") fulfilled += 1;
    } catch (err) {
      errors += 1;
      logger.error({ err, orderId: order.id }, "Pending payment reconciliation failed");
    }
  }

  return {
    inspected: orders.length,
    fulfilled,
    errors,
    cursor: orders.length ? orders[orders.length - 1] : null,
  };
}

export function startPendingPaymentReconciliationLoop({
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  batch = reconcilePendingPaymentsBatch,
} = {}) {
  let running = false;
  let cursor = null;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      let result = await batch({ cursor, limit: batchSize });
      if (result.inspected === 0 && cursor) {
        cursor = null;
        result = await batch({ cursor, limit: batchSize });
      }
      cursor = result.cursor;
      if (result.fulfilled || result.errors) {
        logger.info({ inspected: result.inspected, fulfilled: result.fulfilled, errors: result.errors },
          "Pending payment reconciliation batch completed");
      }
    } catch (err) {
      logger.error({ err }, "Pending payment reconciliation loop failed");
    } finally {
      running = false;
    }
  }

  void runOnce();
  const timer = setInterval(runOnce, intervalMs);
  return () => clearInterval(timer);
}
