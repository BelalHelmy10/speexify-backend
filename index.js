import "dotenv/config";
import http from "http";
import app from "./src/app.js";
import { logger } from "./src/lib/logger.js";
import { setupWebRtcSignaling } from "./src/webrtcSignaling.js";
import { setupSupportWebSocket } from "./src/services/supportWebSocket.js";
import { sessionStoreInfo } from "./src/middleware/session.js";
import { startObservabilityAlerts } from "./src/observability/alerts.js";
import { startNotificationDeliveryLoop } from "./src/services/notificationDeliveryLoop.js";
import { startPendingPaymentReconciliationLoop } from "./src/services/providerPaymentReconciliation.js";

logger.info({ sessionStore: sessionStoreInfo }, "[boot] Session store configured");

const PORT = Number(process.env.PORT || 5050);

const server = http.createServer(app);
setupSupportWebSocket(server);
setupWebRtcSignaling(server);
const stopObservabilityAlerts = startObservabilityAlerts();
// Keep queued booking/cancellation/feedback emails moving even when the
// deployment runs only the API start command. A separately deployed delivery
// worker may also run safely because delivery rows are claimed atomically.
const stopNotificationDelivery = startNotificationDeliveryLoop({
  workerId: `api-notification-delivery-${process.pid}`,
});
const stopPaymentReconciliation = startPendingPaymentReconciliationLoop();

server.listen(PORT, "0.0.0.0", () => {
  logger.info(
    { port: PORT, sessionStore: sessionStoreInfo },
    "Server started with WebRTC signaling"
  );
});

function shutdown(signal) {
  logger.info({ signal }, "[boot] Shutdown signal received");
  stopObservabilityAlerts();
  stopNotificationDelivery();
  stopPaymentReconciliation();

  server.close((err) => {
    if (err) {
      logger.error({ err }, "[boot] Server close failed");
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
