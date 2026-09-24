import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth-helpers.js";

const router = Router();
const CALENDAR_FEED_TTL_DAYS = Math.min(
  Math.max(Number(process.env.CALENDAR_FEED_TTL_DAYS) || 30, 1),
  90
);
const CALENDAR_FEED_TTL_MS = CALENDAR_FEED_TTL_DAYS * 24 * 60 * 60 * 1000;

function hashFeedToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createFeedToken() {
  return crypto.randomBytes(32).toString("base64url");
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
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { calendarFeedRevokedAt: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });

  const token = createFeedToken();
  const expiresAt = new Date(Date.now() + CALENDAR_FEED_TTL_MS);
  await prisma.calendarFeedToken.create({
    data: {
      userId,
      tokenHash: hashFeedToken(token),
      expiresAt,
    },
  });

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol)
    .split(",")[0]
    .trim();
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  const httpsUrl = `${base}/api/calendar.ics?token=${encodeURIComponent(
    token
  )}`;
  const webcalUrl = httpsUrl.replace(/^https?:\/\//, "webcal://");

  res.json({
    httpsUrl,
    webcalUrl,
    expiresAt,
    revokedAt: user.calendarFeedRevokedAt || null,
  });
});

// --------------------------------------------------------------------------
// POST /api/calendar/export-link/revoke
// --------------------------------------------------------------------------
router.post("/calendar/export-link/revoke", requireAuth, async (req, res) => {
  const revokedAt = new Date();
  await prisma.$transaction([
    prisma.calendarFeedToken.updateMany({
      where: { userId: req.viewUserId, revokedAt: null },
      data: { revokedAt },
    }),
    // Keep the legacy timestamp populated for older clients and audit views.
    prisma.user.update({
      where: { id: req.viewUserId },
      data: { calendarFeedRevokedAt: revokedAt },
    }),
  ]);

  res.json({ ok: true, revokedAt });
});

// --------------------------------------------------------------------------
// GET /api/calendar.ics
// --------------------------------------------------------------------------
router.get("/calendar.ics", async (req, res) => {
  const token = String(req.query.token || "");
  if (!token || token.length < 40 || token.length > 120) {
    return res.status(401).send("Invalid calendar token");
  }

  const tokenRecord = await prisma.calendarFeedToken.findUnique({
    where: { tokenHash: hashFeedToken(token) },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true },
  });
  if (
    !tokenRecord ||
    tokenRecord.revokedAt ||
    tokenRecord.expiresAt.getTime() <= Date.now()
  ) {
    return res.status(401).send("Invalid calendar token");
  }

  await prisma.calendarFeedToken.update({
    where: { id: tokenRecord.id },
    data: { lastUsedAt: new Date() },
  });

  const sessions = await loadUserSessions(tokenRecord.userId);

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
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(200).send(lines.join("\r\n") + "\r\n");
});

export default router;
