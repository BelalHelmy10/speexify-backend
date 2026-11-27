// The classroom socket answers the client's ping, so a page can tell a live
// connection from one that died silently (network change, laptop sleep).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";

process.env.WS_AUTH_ENABLED = "false";

test("the classroom socket answers ping with pong", async () => {
  const { setupWebRtcSignaling } = await import("../../src/webrtcSignaling/setup.js");
  const server = http.createServer();
  const signaling = setupWebRtcSignaling(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/classroom`);
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const reply = new Promise((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") resolve(msg);
      });
    });
    ws.send(JSON.stringify({ type: "ping", ts: 123 }));
    const pong = await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error("no pong")), 3000))]);
    assert.equal(pong.ts, 123);
  } finally {
    ws.terminate();
    signaling?.shutdown?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
