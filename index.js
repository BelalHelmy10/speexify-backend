import "dotenv/config";
import http from "http";
import app from "./src/app.js";
import { logger } from "./src/lib/logger.js";
import { setupWebRtcSignaling } from "./src/webrtcSignaling.js";
import { setupSupportWebSocket } from "./src/services/supportWebSocket.js";
import { startSessionReminderScheduler } from "./src/jobs/sessionReminders.js";

console.log("[BOOT] REDIS_URL:", process.env.REDIS_URL ? "SET" : "MISSING");

const PORT = Number(process.env.PORT || 5050);

const server = http.createServer(app);
setupSupportWebSocket(server);
setupWebRtcSignaling(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log("=== HTTP + WebSocket server listening on", PORT, "===");
  logger.info({ port: PORT }, "Server started with WebRTC signaling");

  // ✅ Start reminders scheduler (in-app + email)
  startSessionReminderScheduler({
    intervalMs: 5 * 60 * 1000, // every 5 minutes
    windowMinutes: 6,
  });
});
