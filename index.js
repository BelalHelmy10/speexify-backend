// index.js (root)
import http from "http";
import app from "./src/app.js";
import { logger } from "./src/lib/logger.js";
import { setupWebRtcSignaling } from "./src/webrtcSignaling.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

// Create a single HTTP server for Express + WebSockets
const server = http.createServer(app);

// Attach WebRTC signaling to that server
setupWebRtcSignaling(server);

server.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "Server started");
});
