import "dotenv/config";
import { logger } from "../src/lib/logger.js";
import { processNotificationDeliveryBatch } from "../src/services/emailService.js";

const intervalMs = Number(process.env.NOTIFICATION_DELIVERY_INTERVAL_MS || 30_000);
const batchSize = Number(process.env.NOTIFICATION_DELIVERY_BATCH_SIZE || 25);

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("NOTIFICATION_DELIVERY_INTERVAL_MS must be a positive number");
}
if (!Number.isFinite(batchSize) || batchSize <= 0) {
  throw new Error("NOTIFICATION_DELIVERY_BATCH_SIZE must be a positive number");
}

let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const result = await processNotificationDeliveryBatch({
      limit: batchSize,
      workerId: `notification-delivery-${process.pid}`,
    });
    if (result.inspected) logger.info(result, "[worker:notification-delivery] batch processed");
  } catch (err) {
    logger.error({ err }, "[worker:notification-delivery] batch failed");
  } finally {
    running = false;
  }
}

logger.info(
  { intervalMs, batchSize },
  "[worker:notification-delivery] starting"
);
await runOnce();
const interval = setInterval(runOnce, intervalMs);

const shutdown = (signal) => {
  logger.info({ signal }, "[worker:notification-delivery] stopping");
  clearInterval(interval);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
