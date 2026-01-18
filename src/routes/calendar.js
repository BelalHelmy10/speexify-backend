import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth-helpers.js";
import { SESSION_SECRET } from "../config/env.js";

const router = Router();

// Use a dedicated secret if provided; fall back to SESSION_SECRET.
const FEED_SECRET =
  process.env.CALENDAR_FEED_SECRET || SESSION_SECRET || "dev-secret";

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecodeToString(s) {
  const b64 = String(s)
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(s).length / 4) * 4, "=");
  return Buffer.from(b64, "base64").toString("utf8");
}

function signToken(payloadObj) {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = base64url(
    crypto.createHmac("sha256", FEED_SECRET).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expected = base64url(
    crypto.createHmac("sha256", FEED_SECRET).update(payload).digest()
  );

  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }

  try {
    const json = JSON.parse(base64urlDecodeToString(payload));
    if (!json || typeof json.userId !== "number") return null;
    if (json.exp && Date.now() > Number(json.exp)) return null;
    return json;
  } catch {
    return null;
  }
}

function icsEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function toIcsUtc(dt) {
  return new Date(dt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

async function loadUserSessions(userId) {
  return prisma.session.findMany({
    where: {
      // ✅ Exclude cancelled sessions from calendar export
      status: { not: "canceled" },
      OR: [
        { participants: { some: { userId } } },
        { userId },
        { teacherId: userId },
      ],
    },
    include: {
      teacher: { select: { id: true, name: true, email: true } },
    },
    orderBy: { startAt: "asc" },
  });
}

// --------------------------------------------------------------------------
// GET /api/calendar/export-link
// --------------------------------------------------------------------------
router.get("/calendar/export-link", requireAuth, async (req, res) => {
  const userId = req.viewUserId;
  const exp = Date.now() + 180 * 24 * 60 * 60 * 1000;
  const token = signToken({ userId, exp });

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol)
    .split(",")[0]
    .trim();
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  const httpsUrl = `${base}/api/calendar.ics?token=${encodeURIComponent(
    token
  )}`;
  const webcalUrl = httpsUrl.replace(/^https?:\/\//, "webcal://");

  res.json({ httpsUrl, webcalUrl, expiresAt: exp });
});

// --------------------------------------------------------------------------
// GET /api/calendar.ics
// --------------------------------------------------------------------------
router.get("/calendar.ics", async (req, res) => {
  const token = String(req.query.token || "");
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).send("Invalid calendar token");
  }

  const sessions = await loadUserSessions(payload.userId);

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Speexify//Calendar Feed//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");

  for (const s of sessions) {
    const start = s.startAt;
    const end = s.endAt || new Date(new Date(start).getTime() + 60 * 60 * 1000);

    const uid = `speexify-session-${s.id}@speexify`;
    const isCancelled = s.status === "CANCELLED";
    const title = isCancelled
      ? `❌ CANCELLED: ${s.title || "Session"}`
      : s.title || "Session";
    const teacher = s.teacher?.name || s.teacher?.email || "";
    const joinUrl = s.joinUrl || "";
    const status = s.status || "CONFIRMED";

    const descParts = [];
    if (teacher) descParts.push(`Teacher: ${teacher}`);
    if (isCancelled) descParts.push(`This session has been cancelled.`);
    else if (status !== "CONFIRMED") descParts.push(`Status: ${status}`);
    if (joinUrl) descParts.push(`Join: ${joinUrl}`);
    const description = descParts.join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(uid)}`);
    lines.push(`DTSTAMP:${toIcsUtc(new Date())}`);
    lines.push(`DTSTART:${toIcsUtc(start)}`);
    lines.push(`DTEND:${toIcsUtc(end)}`);
    lines.push(`SUMMARY:${icsEscape(title)}`);

    // Set STATUS
    const icsStatus = isCancelled ? "CANCELLED" : "CONFIRMED";
    lines.push(`STATUS:${icsStatus}`);

    // Set COLOR for visual dimming (light gray for cancelled)
    const color = isCancelled ? "lightgray" : ""; // Or set a default color if desired
    if (color) lines.push(`COLOR:${color}`);

    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    if (joinUrl) lines.push(`URL:${icsEscape(joinUrl)}`);

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(lines.join("\r\n") + "\r\n");
});

export default router;
