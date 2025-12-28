// src/routes/notifications.js
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth-helpers.js";

const router = Router();

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

    const deleted = await prisma.notification.deleteMany({
      where: { id, userId },
    });

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
    const updated = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
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
        readAt: { not: null }, // Only delete notifications that have been read
      },
    });

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
