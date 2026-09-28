import { logger } from "../lib/logger.js";
import { processNotificationDeliveryBatch } from "./emailService.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 25;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Start the durable email delivery loop. The database claim in
 * processNotificationDeliveryBatch makes this safe to run in more than one
 * API/worker process at the same time.
 */
export function startNotificationDeliveryLoop({
  intervalMs = process.env.NOTIFICATION_DELIVERY_INTERVAL_MS,
  batchSize = process.env.NOTIFICATION_DELIVERY_BATCH_SIZE,
  workerId = `notification-delivery-${process.pid}`,
} = {}) {
  const resolvedIntervalMs = positiveNumber(intervalMs, DEFAULT_INTERVAL_MS);
  const resolvedBatchSize = positiveNumber(batchSize, DEFAULT_BATCH_SIZE);
  let running = false;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const result = await processNotificationDeliveryBatch({
        limit: resolvedBatchSize,
        workerId,
      });
      if (result.inspected) {
        logger.info(result, "[notification-delivery] batch processed");
      }
    } catch (err) {
      logger.error({ err }, "[notification-delivery] batch failed");
    } finally {
      running = false;
    }
  }

  logger.info(
    { intervalMs: resolvedIntervalMs, batchSize: resolvedBatchSize, workerId },
    "[notification-delivery] loop starting"
  );
  void runOnce();

  const interval = setInterval(runOnce, resolvedIntervalMs);

  return () => {
    clearInterval(interval);
    logger.info({ workerId }, "[notification-delivery] loop stopping");
  };
}
