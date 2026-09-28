import "dotenv/config";
import { logger } from "../src/lib/logger.js";
import { startNotificationDeliveryLoop } from "../src/services/notificationDeliveryLoop.js";

const stop = startNotificationDeliveryLoop({
  workerId: `notification-delivery-${process.pid}`,
});

const shutdown = (signal) => {
  logger.info({ signal }, "[worker:notification-delivery] stopping");
  stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
