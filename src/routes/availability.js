// src/routes/availability.js
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { logger } from "../lib/logger.js";

const router = Router();

/* ========================================================================== */
/*                           AVAILABILITY VALIDATION                          */
/* ========================================================================== */

/**
 * Validate time format (HH:MM)
 */
function isValidTimeFormat(time) {
  if (!time || typeof time !== "string") return false;
  const match = time.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
  return !!match;
}

/**
 * Parse time string to minutes since midnight
 */
function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if two time ranges overlap
 */
function timesOverlap(start1, end1, start2, end2) {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);
  return s1 < e2 && s2 < e1;
}

/* ========================================================================== */
/*                        USER: AVAILABILITY MANAGEMENT                       */
/* ========================================================================== */

/**
 * GET /api/availability
 * Get current user's availability slots
 */
router.get("/availability", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const { status = "active", includeInactive } = req.query;

    const where = { userId };

    // Filter by status unless includeInactive is set
    if (!includeInactive) {
      where.status = status;
    }

    const slots = await prisma.availability.findMany({
      where,
      orderBy: [
        { isRecurring: "desc" },
        { dayOfWeek: "asc" },
        { specificDate: "asc" },
        { startTime: "asc" },
      ],
    });

    res.json(slots);
  } catch (err) {
    logger.error({ err }, "GET /availability failed");
    res.status(500).json({ error: "Failed to load availability" });
  }
});

/**
 * POST /api/availability
 * Create a new availability slot
 */
router.post("/availability", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const {
      dayOfWeek,
      specificDate,
      startTime,
      endTime,
      timezone,
      isRecurring = true,
      note,
    } = req.body;

    // Validation
    if (!startTime || !endTime) {
      return res
        .status(400)
        .json({ error: "startTime and endTime are required" });
    }

    if (!isValidTimeFormat(startTime) || !isValidTimeFormat(endTime)) {
      return res.status(400).json({ error: "Invalid time format. Use HH:MM" });
    }

    if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
      return res
        .status(400)
        .json({ error: "startTime must be before endTime" });
    }

    // For recurring slots, dayOfWeek is required
    if (isRecurring && (dayOfWeek === null || dayOfWeek === undefined)) {
      return res
        .status(400)
        .json({ error: "dayOfWeek is required for recurring slots" });
    }

    // For non-recurring slots, specificDate is required
    if (!isRecurring && !specificDate) {
      return res
        .status(400)
        .json({ error: "specificDate is required for non-recurring slots" });
    }

    // Validate dayOfWeek range
    if (isRecurring && (dayOfWeek < 0 || dayOfWeek > 6)) {
      return res
        .status(400)
        .json({ error: "dayOfWeek must be 0-6 (Sunday-Saturday)" });
    }

    // Check for overlapping slots
    const existingSlots = await prisma.availability.findMany({
      where: {
        userId,
        status: "active",
        ...(isRecurring
          ? { isRecurring: true, dayOfWeek: Number(dayOfWeek) }
          : { isRecurring: false, specificDate: new Date(specificDate) }),
      },
    });

    const hasOverlap = existingSlots.some((slot) =>
      timesOverlap(startTime, endTime, slot.startTime, slot.endTime)
    );

    if (hasOverlap) {
      return res.status(409).json({
        error: "This time slot overlaps with an existing availability",
      });
    }

    // Get user's timezone if not provided
    let tz = timezone;
    if (!tz) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      tz = user?.timezone || "Africa/Cairo";
    }

    const slot = await prisma.availability.create({
      data: {
        userId,
        dayOfWeek: isRecurring ? Number(dayOfWeek) : null,
        specificDate:
          !isRecurring && specificDate ? new Date(specificDate) : null,
        startTime,
        endTime,
        timezone: tz,
        isRecurring,
        note: note?.trim() || null,
        status: "active",
      },
    });

    res.status(201).json(slot);
  } catch (err) {
    logger.error({ err }, "POST /availability failed");
    res.status(500).json({ error: "Failed to create availability" });
  }
});

/**
 * POST /api/availability/bulk
 * Create multiple availability slots at once
 */
router.post("/availability/bulk", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const { slots } = req.body;

    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: "slots array is required" });
    }

    if (slots.length > 50) {
      return res.status(400).json({ error: "Maximum 50 slots per request" });
    }

    // Get user's timezone
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const defaultTimezone = user?.timezone || "Africa/Cairo";

    // Validate all slots first
    const validatedSlots = [];
    for (const slot of slots) {
      const {
        dayOfWeek,
        specificDate,
        startTime,
        endTime,
        timezone,
        isRecurring = true,
        note,
      } = slot;

      if (!startTime || !endTime) {
        return res
          .status(400)
          .json({ error: "Each slot needs startTime and endTime" });
      }

      if (!isValidTimeFormat(startTime) || !isValidTimeFormat(endTime)) {
        return res
          .status(400)
          .json({ error: `Invalid time format: ${startTime} - ${endTime}` });
      }

      if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
        return res
          .status(400)
          .json({
            error: `startTime must be before endTime: ${startTime} - ${endTime}`,
          });
      }

      validatedSlots.push({
        userId,
        dayOfWeek: isRecurring ? Number(dayOfWeek) : null,
        specificDate:
          !isRecurring && specificDate ? new Date(specificDate) : null,
        startTime,
        endTime,
        timezone: timezone || defaultTimezone,
        isRecurring,
        note: note?.trim() || null,
        status: "active",
      });
    }

    // Create all slots
    const created = await prisma.availability.createMany({
      data: validatedSlots,
    });

    res.status(201).json({
      created: created.count,
      message: `Created ${created.count} availability slots`,
    });
  } catch (err) {
    logger.error({ err }, "POST /availability/bulk failed");
    res.status(500).json({ error: "Failed to create availability slots" });
  }
});

/**
 * PATCH /api/availability/:id
 * Update an availability slot
 */
router.patch("/availability/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const id = Number(req.params.id);

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: "Invalid slot ID" });
    }

    // Check ownership
    const existing = await prisma.availability.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: "Availability slot not found" });
    }

    if (existing.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to edit this slot" });
    }

    const { startTime, endTime, note, status } = req.body;

    // Validate times if provided
    if (startTime && !isValidTimeFormat(startTime)) {
      return res.status(400).json({ error: "Invalid startTime format" });
    }
    if (endTime && !isValidTimeFormat(endTime)) {
      return res.status(400).json({ error: "Invalid endTime format" });
    }

    const newStart = startTime || existing.startTime;
    const newEnd = endTime || existing.endTime;

    if (timeToMinutes(newStart) >= timeToMinutes(newEnd)) {
      return res
        .status(400)
        .json({ error: "startTime must be before endTime" });
    }

    // Check for overlaps with other slots (excluding this one)
    if (startTime || endTime) {
      const otherSlots = await prisma.availability.findMany({
        where: {
          userId,
          status: "active",
          id: { not: id },
          ...(existing.isRecurring
            ? { isRecurring: true, dayOfWeek: existing.dayOfWeek }
            : { isRecurring: false, specificDate: existing.specificDate }),
        },
      });

      const hasOverlap = otherSlots.some((slot) =>
        timesOverlap(newStart, newEnd, slot.startTime, slot.endTime)
      );

      if (hasOverlap) {
        return res.status(409).json({
          error: "This time slot overlaps with an existing availability",
        });
      }
    }

    const updated = await prisma.availability.update({
      where: { id },
      data: {
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
        ...(note !== undefined ? { note: note?.trim() || null } : {}),
        ...(status ? { status } : {}),
      },
    });

    res.json(updated);
  } catch (err) {
    logger.error({ err }, "PATCH /availability/:id failed");
    res.status(500).json({ error: "Failed to update availability" });
  }
});

/**
 * DELETE /api/availability/:id
 * Delete an availability slot
 */
router.delete("/availability/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const id = Number(req.params.id);

    if (!id || isNaN(id)) {
      return res.status(400).json({ error: "Invalid slot ID" });
    }

    // Check ownership
    const existing = await prisma.availability.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: "Availability slot not found" });
    }

    if (existing.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this slot" });
    }

    await prisma.availability.delete({ where: { id } });

    res.json({ ok: true, deleted: id });
  } catch (err) {
    logger.error({ err }, "DELETE /availability/:id failed");
    res.status(500).json({ error: "Failed to delete availability" });
  }
});

/**
 * DELETE /api/availability
 * Clear all availability for current user (with optional filters)
 */
router.delete("/availability", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const { dayOfWeek, isRecurring } = req.query;

    const where = { userId };

    if (dayOfWeek !== undefined) {
      where.dayOfWeek = Number(dayOfWeek);
    }

    if (isRecurring !== undefined) {
      where.isRecurring = isRecurring === "true";
    }

    const result = await prisma.availability.deleteMany({ where });

    res.json({ ok: true, deleted: result.count });
  } catch (err) {
    logger.error({ err }, "DELETE /availability (bulk) failed");
    res.status(500).json({ error: "Failed to clear availability" });
  }
});

/* ========================================================================== */
/*                        ADMIN: AVAILABILITY MANAGEMENT                      */
/* ========================================================================== */

/**
 * GET /api/admin/availability
 * Get all availability slots (admin view)
 */
router.get(
  "/admin/availability",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        role,
        userId,
        status = "active",
        dayOfWeek,
        limit = "100",
        offset = "0",
      } = req.query;

      const where = {};

      // Filter by status
      if (status) {
        where.status = status;
      }

      // Filter by specific user
      if (userId) {
        where.userId = Number(userId);
      }

      // Filter by user role
      if (role) {
        where.user = { role };
      }

      // Filter by day of week
      if (dayOfWeek !== undefined) {
        where.dayOfWeek = Number(dayOfWeek);
      }

      const [items, total] = await Promise.all([
        prisma.availability.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
                timezone: true,
              },
            },
          },
          orderBy: [
            { user: { name: "asc" } },
            { dayOfWeek: "asc" },
            { startTime: "asc" },
          ],
          take: Number(limit),
          skip: Number(offset),
        }),
        prisma.availability.count({ where }),
      ]);

      res.json({ items, total });
    } catch (err) {
      logger.error({ err }, "GET /admin/availability failed");
      res.status(500).json({ error: "Failed to load availability data" });
    }
  }
);

/**
 * GET /api/admin/availability/user/:userId
 * Get availability for a specific user (admin view)
 */
router.get(
  "/admin/availability/user/:userId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);

      if (!userId || isNaN(userId)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
        },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const slots = await prisma.availability.findMany({
        where: { userId },
        orderBy: [
          { isRecurring: "desc" },
          { dayOfWeek: "asc" },
          { specificDate: "asc" },
          { startTime: "asc" },
        ],
      });

      // Group by day of week for easier display
      const byDayOfWeek = {
        0: [], // Sunday
        1: [], // Monday
        2: [], // Tuesday
        3: [], // Wednesday
        4: [], // Thursday
        5: [], // Friday
        6: [], // Saturday
      };

      const specificDates = [];

      for (const slot of slots) {
        if (slot.isRecurring && slot.dayOfWeek !== null) {
          byDayOfWeek[slot.dayOfWeek].push(slot);
        } else if (!slot.isRecurring) {
          specificDates.push(slot);
        }
      }

      res.json({
        user,
        slots,
        byDayOfWeek,
        specificDates,
        summary: {
          totalSlots: slots.length,
          activeSlots: slots.filter((s) => s.status === "active").length,
          recurringSlots: slots.filter((s) => s.isRecurring).length,
          specificDateSlots: specificDates.length,
        },
      });
    } catch (err) {
      logger.error({ err }, "GET /admin/availability/user/:userId failed");
      res.status(500).json({ error: "Failed to load user availability" });
    }
  }
);

/**
 * GET /api/admin/availability/summary
 * Get summary of all users' availability (admin dashboard)
 */
router.get(
  "/admin/availability/summary",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { role } = req.query;

      const userWhere = role
        ? { role }
        : { role: { in: ["learner", "teacher"] } };

      // Get all users with their availability count
      const users = await prisma.user.findMany({
        where: {
          ...userWhere,
          isDisabled: false,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          _count: {
            select: {
              availabilities: {
                where: { status: "active" },
              },
            },
          },
        },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      });

      // Get detailed availability for users who have set availability
      const usersWithAvailability = users.filter(
        (u) => u._count.availabilities > 0
      );
      const usersWithoutAvailability = users.filter(
        (u) => u._count.availabilities === 0
      );

      // Get availability distribution by day of week
      const dayDistribution = await prisma.availability.groupBy({
        by: ["dayOfWeek"],
        where: {
          status: "active",
          isRecurring: true,
          user: userWhere,
        },
        _count: { id: true },
      });

      res.json({
        totalUsers: users.length,
        usersWithAvailability: usersWithAvailability.length,
        usersWithoutAvailability: usersWithoutAvailability.length,
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          timezone: u.timezone,
          availabilityCount: u._count.availabilities,
          hasAvailability: u._count.availabilities > 0,
        })),
        dayDistribution: dayDistribution.reduce((acc, d) => {
          if (d.dayOfWeek !== null) {
            acc[d.dayOfWeek] = d._count.id;
          }
          return acc;
        }, {}),
      });
    } catch (err) {
      logger.error({ err }, "GET /admin/availability/summary failed");
      res.status(500).json({ error: "Failed to load availability summary" });
    }
  }
);

export default router;
