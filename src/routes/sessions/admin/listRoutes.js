// src/routes/sessions/admin/listRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  logger,
  ADMIN_SESSIONS_DEFAULT_LIMIT,
  ADMIN_SESSIONS_MAX_LIMIT,
  ADMIN_SESSIONS_MAX_OFFSET,
  parseBoundedInt,
} from "./shared.js";

const router = Router();

// GET /api/admin/sessions - List all sessions (admin)
router.get("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      q = "",
      userId = "",
      teacherId = "",
      type = "",
      range = "",
    } = req.query;
    const take = parseBoundedInt(req.query.limit, {
      fallback: ADMIN_SESSIONS_DEFAULT_LIMIT,
      min: 1,
      max: ADMIN_SESSIONS_MAX_LIMIT,
    });
    const skip = parseBoundedInt(req.query.offset, {
      fallback: 0,
      min: 0,
      max: ADMIN_SESSIONS_MAX_OFFSET,
    });

    const now = new Date();
    const where = {};

    if (userId && Number.isFinite(Number(userId))) {
      const uid = Number(userId);
      where.OR = [{ userId: uid }, { participants: { some: { userId: uid } } }];
    }

    if (teacherId && Number.isFinite(Number(teacherId))) {
      where.teacherId = Number(teacherId);
    }

    if (type === "ONE_ON_ONE" || type === "GROUP") {
      where.type = type;
    }

    if (q) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { joinUrl: { contains: q, mode: "insensitive" } },
          ],
        },
      ];
    }

    if (range === "upcoming") {
      where.AND = [
        ...(where.AND || []),
        { startAt: { gte: now } },
        { status: { not: "canceled" } },
      ];
    } else if (range === "past") {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { endAt: { lt: now } },
            { AND: [{ endAt: null }, { startAt: { lt: now } }] },
          ],
        },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.session.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
          participants: {
            select: {
              userId: true,
              status: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: [{ startAt: "desc" }, { id: "desc" }],
        take,
        skip,
      }),
      prisma.session.count({ where }),
    ]);

    const shaped = items.map((s) => {
      const activeParticipants = (s.participants || []).filter(
        (p) => p.status !== "canceled"
      );
      return {
        ...s,
        participantCount: activeParticipants.length,
        learners:
          s.type === "GROUP"
            ? activeParticipants.map((p) => ({
                ...p.user,
                status: p.status,
              }))
            : s.user
              ? [{ ...s.user, status: "booked" }]
              : [],
      };
    });

    return res.json({ items: shaped, total });
  } catch (err) {
    logger.error({ err }, "admin.sessions.list error");
    return res.status(500).json({ error: "Failed to load sessions" });
  }
});

export default router;
