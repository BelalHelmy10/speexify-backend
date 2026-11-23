import { Router } from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ALLOWED_ORIGINS, CALENDAR_FEED_SECRET, isProd } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth-helpers.js";

const router = Router();
const subscriptionTokenPattern = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const legacyTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function signFeedId(feedId) {
  return createHmac("sha256", CALENDAR_FEED_SECRET)
    .update(`calendar-subscription-v1:${feedId}`)
    .digest("base64url");
}

function calendarUrl(req, token) {
  const defaultOrigin = isProd
    ? ALLOWED_ORIGINS.find((value) => value.startsWith("https://")) ||
      process.env.RENDER_EXTERNAL_URL || "https://speexify.com"
    : `${req.protocol}://${req.get("host")}`;
  const origin = process.env.FRONTEND_URL?.trim() || defaultOrigin;
  const url = new URL("/api/calendar.ics", origin);
  url.searchParams.set("token", token);
  return url.href;
}

function manageOwnSubscription(req, res, next) {
  if (req.session.asUserId) {
    return res.status(403).json({ error: "Open your own account to manage calendar sync" });
  }
  return next();
}

router.use(["/calendar/export-link", "/calendar.ics"], (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  return next();
});

router.get("/calendar/export-link", requireAuth, manageOwnSubscription, async (req, res) => {
  const userId = req.user.id;
  const { feedId } = await prisma.calendarSubscription.upsert({
    where: { userId },
    create: { userId, feedId: randomBytes(32).toString("base64url") },
    update: { userId },
    select: { feedId: true },
  });
  const httpsUrl = calendarUrl(req, `v1.${feedId}.${signFeedId(feedId)}`);

  return res.json({
    httpsUrl,
    webcalUrl: httpsUrl.replace(/^https?:\/\//, "webcal://"),
    expiresAt: null,
  });
});

router.post("/calendar/export-link/revoke", requireAuth, manageOwnSubscription, async (req, res) => {
  const userId = req.user.id;
  const revokedAt = new Date();
  await prisma.$transaction([
    prisma.calendarSubscription.deleteMany({ where: { userId } }),
    prisma.calendarFeedToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { calendarFeedRevokedAt: revokedAt },
    }),
  ]);

  return res.json({ ok: true, revokedAt });
});

async function findFeedUserId(token) {
  if (typeof token !== "string") return null;

  const subscription = subscriptionTokenPattern.exec(token);
  if (subscription) {
    const [, feedId, signature] = subscription;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(signFeedId(feedId)))) {
      return null;
    }

    const record = await prisma.calendarSubscription.findUnique({
      where: { feedId, user: { isDisabled: false, deletedAt: null } },
      select: { userId: true },
    });
    return record?.userId ?? null;
  }

  if (!legacyTokenPattern.test(token)) return null;

  const record = await prisma.calendarFeedToken.findUnique({
    where: {
      tokenHash: createHash("sha256").update(token).digest("hex"),
      revokedAt: null,
      expiresAt: { gt: new Date() },
      user: { isDisabled: false, deletedAt: null },
    },
    select: { id: true, userId: true },
  });
  if (!record) return null;

  const { count } = await prisma.calendarFeedToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { lastUsedAt: new Date() },
  });
  return count ? record.userId : null;
}

function icsEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function toIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldCalendarLine(line) {
  if (Buffer.byteLength(line) <= 75) return line;

  let folded = "";
  let lineBytes = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character);
    if (lineBytes + bytes > 75) {
      folded += "\r\n ";
      lineBytes = 1;
    }
    folded += character;
    lineBytes += bytes;
  }
  return folded;
}

router.get("/calendar.ics", async (req, res) => {
  const userId = await findFeedUserId(req.query.token);
  if (!userId) return res.status(401).send("Invalid calendar token");

  const sessions = await prisma.session.findMany({
    where: {
      status: { not: "canceled" },
      OR: [
        { participants: { some: { userId, status: { not: "canceled" } } } },
        { userId },
        { teacherId: userId },
        { trainingAdminId: userId },
      ],
    },
    select: {
      id: true,
      title: true,
      status: true,
      startAt: true,
      endAt: true,
      updatedAt: true,
      joinUrl: true,
      teacher: { select: { name: true, email: true } },
    },
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
  });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Speexify//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "NAME:Speexify Sessions",
    "X-WR-CALNAME:Speexify Sessions",
    "REFRESH-INTERVAL;VALUE=DURATION:PT5M",
    "X-PUBLISHED-TTL:PT5M",
  ];

  for (const session of sessions) {
    const endAt = session.endAt || new Date(session.startAt.getTime() + 60 * 60 * 1000);
    const editedAt = toIcsUtc(session.updatedAt);
    const teacher = session.teacher?.name || session.teacher?.email;
    const description = [
      teacher && `Teacher: ${teacher}`,
      session.status === "completed" && "Status: completed",
      session.joinUrl && `Join: ${session.joinUrl}`,
    ].filter(Boolean).join("\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:speexify-session-${session.id}@speexify`,
      `DTSTAMP:${editedAt}`,
      `LAST-MODIFIED:${editedAt}`,
      `DTSTART:${toIcsUtc(session.startAt)}`,
      `DTEND:${toIcsUtc(endAt)}`,
      `SUMMARY:${icsEscape(session.title || "Session")}`,
      "STATUS:CONFIRMED",
    );
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    if (session.joinUrl) lines.push(`URL:${session.joinUrl.replace(/[\r\n]/g, "")}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR", "");
  return res.type("text/calendar").send(lines.map(foldCalendarLine).join("\r\n"));
});

export default router;
