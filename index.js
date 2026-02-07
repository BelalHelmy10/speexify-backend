import "dotenv/config";
import http from "http";
import app from "./src/app.js";
import { logger } from "./src/lib/logger.js";
import { setupWebRtcSignaling } from "./src/webrtcSignaling.js";
import { setupSupportWebSocket } from "./src/services/supportWebSocket.js";
import { sessionStoreInfo } from "./src/middleware/session.js";

logger.info({ sessionStore: sessionStoreInfo }, "[boot] Session store configured");

const PORT = Number(process.env.PORT || 5050);

const server = http.createServer(app);
setupSupportWebSocket(server);
setupWebRtcSignaling(server);

server.listen(PORT, "0.0.0.0", () => {
  logger.info(
    { port: PORT, sessionStore: sessionStoreInfo },
    "Server started with WebRTC signaling"
  );
});
