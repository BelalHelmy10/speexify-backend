// src/webrtcSignaling/requestUtils.js

function getClientIP(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    return ips[0];
  }
  return request.socket?.remoteAddress || "unknown";
}

export { getClientIP };
