import http from "http";
import app from "./src/app.js";
import { logger } from "./src/lib/logger.js";
import { setupWebRtcSignaling } from "./src/webrtcSignaling.js";

const PORT = Number(process.env.PORT || 5050);

const server = http.createServer(app);
setupWebRtcSignaling(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log("=== HTTP + WebSocket server listening on", PORT, "===");
  logger.info({ port: PORT }, "Server started with WebRTC signaling");
});
