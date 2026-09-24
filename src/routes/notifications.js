// src/routes/notifications.js
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import {
  subscribeNotificationStream,
  publishNotificationEvent,
} from "../services/notificationStreamHub.js";

const router = Router();

// --------------------------------------------------------------------------
// GET /api/admin/notification-deliveries
// Durable email delivery/retry dashboard data for operations.
// --------------------------------------------------------------------------
router.get(
  "/admin/notification-deliveries",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const allowedStatuses = new Set(["PENDING", "PROCESSING", "SENT", "FAILED"]);
      const requestedStatus = String(req.query.status || "").toUpperCase();
      const status = allowedStatuses.has(requestedStatus) ? requestedStatus : null;
      const limitRaw = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.floor(limitRaw), 1), 100)
        : 50;

      const where = status ? { status } : {};
      const [items, counts] = await prisma.$transaction([
        prisma.notificationDelivery.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
          select: {
            id: true,
            userId: true,
            notificationId: true,
            channel: true,
            eventType: true,
            recipient: true,
            subject: true,
            status: true,
            attempts: true,
            nextAttemptAt: true,
            lastAttemptAt: true,
            sentAt: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.notificationDelivery.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
      ]);

      return res.json({
        items,
        counts: Object.fromEntries(
          counts.map((row) => [row.status, row._count._all])
        ),
        limit,
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to load notification delivery status" });
    }
  }
);

// --------------------------------------------------------------------------
// POST /api/admin/notification-deliveries/:id/retry
// Make one failed delivery immediately eligible for the worker.
// --------------------------------------------------------------------------
router.post(
  "/admin/notification-deliveries/:id/retry",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid delivery id" });
      }

      const updated = await prisma.notificationDelivery.updateMany({
        where: { id, status: { in: ["FAILED", "PENDING"] } },
        data: {
          status: "PENDING",
          nextAttemptAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });
      if (!updated.count) {
        return res.status(404).json({ error: "Retryable delivery not found" });
      }
      return res.json({ ok: true, queued: true });
    } catch (err) {
      return res.status(500).json({ error: "Failed to queue notification delivery retry" });
    }
  }
);

// --------------------------------------------------------------------------
// GET /api/notifications/stream
// Server-Sent Events for live notification updates
// --------------------------------------------------------------------------
router.get("/notifications/stream", requireAuth, async (req, res) => {
  const userId = req.user.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 25000);

  subscribeNotificationStream(userId, res);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// --------------------------------------------------------------------------
// GET /api/notifications
// Returns the latest notifications for the logged-in user (bell feed)
// --------------------------------------------------------------------------
router.get("/notifications", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 20;

    // Cursor pagination (id of the last item you have)
    const cursorId = req.query.cursor ? Number(req.query.cursor) : null;
    const cursor =
      cursorId && Number.isFinite(cursorId) ? { id: cursorId } : undefined;

    const [items, unreadCount] = await prisma.$transaction([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { id: "desc" },
        take: limit,
        ...(cursor
          ? {
              cursor,
              skip: 1,
            }
          : {}),
      }),
      prisma.notification.count({
        where: { userId, readAt: null },
      }),
    ]);

    const nextCursor = items.length ? items[items.length - 1].id : null;

    return res.json({ items, unreadCount, nextCursor });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load notifications" });
  }
});

// --------------------------------------------------------------------------
// GET /api/notifications/test
// Creates a test notification for the logged-in user (dev sanity check)
// Useful because browser address bar uses GET.
// --------------------------------------------------------------------------
router.get("/notifications/test", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const notif = await prisma.notification.create({
      data: {
        userId,
        type: "test",
        title: "Test notification",
        body: "This is a test notification.",
        data: { source: "manual_test_get" },
      },
    });

    return res.status(201).json({ ok: true, notification: notif });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to create test notification" });
  }
});

// --------------------------------------------------------------------------
// POST /api/notifications/test
// Same as above, for Postman/curl usage.
// --------------------------------------------------------------------------
router.post("/notifications/test", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const notif = await prisma.notification.create({
      data: {
        userId,
        type: "test",
        title: "Test notification",
        body: "This is a test notification.",
        data: { source: "manual_test_post" },
      },
    });

    return res.status(201).json({ ok: true, notification: notif });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to create test notification" });
  }
});

// --------------------------------------------------------------------------
// POST /api/notifications/:id/read
// Marks one notification as read
// --------------------------------------------------------------------------
router.post("/notifications/:id/read", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "Invalid id" });

    const updated = await prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (updated.count > 0) {
      publishNotificationEvent(userId, {
        kind: "read",
        notificationId: id,
        unreadDelta: -1,
      });
    }

    return res.json({ ok: true, updatedCount: updated.count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to mark as read" });
  }
});

// --------------------------------------------------------------------------
// POST /api/notifications/:id/delete
// Deletes one notification (only if it belongs to the logged-in user)
// --------------------------------------------------------------------------
router.post("/notifications/:id/delete", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.notification.findFirst({
      where: { id, userId },
    });

    const deleted = await prisma.notification.deleteMany({
      where: { id, userId },
    });

    if (deleted.count > 0 && existing) {
      publishNotificationEvent(userId, {
        kind: "deleted",
        notificationId: id,
        unreadDelta: existing.readAt ? 0 : -1,
      });
    }

    return res.json({ ok: true, deletedCount: deleted.count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete notification" });
  }
});

// --------------------------------------------------------------------------
// POST /api/notifications/read-all
// Marks all notifications as read
// --------------------------------------------------------------------------
router.post("/notifications/read-all", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const unreadBefore = await prisma.notification.count({
      where: { userId, readAt: null },
    });

    const updated = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (updated.count > 0) {
      publishNotificationEvent(userId, {
        kind: "read_all",
        unreadDelta: -unreadBefore,
      });
    }

    return res.json({ ok: true, updatedCount: updated.count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to mark all as read" });
  }
});

// --------------------------------------------------------------------------
// POST /api/notifications/clear-read
// Deletes all READ notifications for the logged-in user
// (This endpoint was MISSING and causing the "Clear read" button to fail!)
// --------------------------------------------------------------------------
router.post("/notifications/clear-read", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const deleted = await prisma.notification.deleteMany({
      where: {
        userId,
        readAt: { not: null },
      },
    });

    if (deleted.count > 0) {
      publishNotificationEvent(userId, {
        kind: "cleared_read",
        deletedCount: deleted.count,
      });
    }

    return res.json({ ok: true, deletedCount: deleted.count });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to clear read notifications" });
  }
});

// --------------------------------------------------------------------------
// DELETE /api/notifications/:id
// Alternative REST-style delete endpoint
// --------------------------------------------------------------------------
router.delete("/notifications/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "Invalid id" });

    const deleted = await prisma.notification.deleteMany({
      where: { id, userId },
    });

    return res.json({ ok: true, deletedCount: deleted.count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete notification" });
  }
});

export default router;
