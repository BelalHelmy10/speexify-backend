// src/webrtcSignaling/connectionTracker.js

import { CONFIG } from "./config.js";
import { getMeta } from "./socketMeta.js";

const connectionsByIP = new Map();
let totalConnections = 0;

function trackConnection(ws, ip) {
  totalConnections++;

  let ipConnections = connectionsByIP.get(ip);
  if (!ipConnections) {
    ipConnections = new Set();
    connectionsByIP.set(ip, ipConnections);
  }
  ipConnections.add(ws);

  getMeta(ws).ip = ip;
}

function untrackConnection(ws) {
  totalConnections = Math.max(0, totalConnections - 1);

  const meta = getMeta(ws);
  if (meta.ip) {
    const ipConnections = connectionsByIP.get(meta.ip);
    if (ipConnections) {
      ipConnections.delete(ws);
      if (ipConnections.size === 0) {
        connectionsByIP.delete(meta.ip);
      }
    }
  }
}

function canAcceptConnection(ip) {
  if (totalConnections >= CONFIG.MAX_CONNECTIONS_TOTAL) {
    return { allowed: false, reason: "Server at maximum capacity" };
  }

  const ipConnections = connectionsByIP.get(ip);
  if (ipConnections && ipConnections.size >= CONFIG.MAX_CONNECTIONS_PER_IP) {
    return { allowed: false, reason: "Too many connections from your IP" };
  }

  return { allowed: true };
}

function getTotalConnections() {
  return totalConnections;
}

export { trackConnection, untrackConnection, canAcceptConnection, getTotalConnections };
