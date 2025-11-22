// index.js (root)

import http from "http";
import app from "./src/app.js";
import { logger } from "./src/lib/logger.js";
import { attachWebRtcSignaling } from "./src/webrtcSignaling.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

// 1) Create an HTTP server from Express
const server = http.createServer(app);

// 2) Attach WebRTC signaling to this server (the /ws/prep WebSocket endpoint)
attachWebRtcSignaling(server);

// 3) Start the combined server
server.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "Server + WebRTC signaling started");
});
