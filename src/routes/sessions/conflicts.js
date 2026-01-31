// src/routes/sessions/conflicts.js
// Scheduling conflict detection endpoint

import {
    Router,
    requireAuth,
    findSessionConflicts,
    logger,
} from "./_shared.js";

const router = Router();

// --------------------------------------------------------------------------
// GET /api/sessions/conflicts - Check for scheduling conflicts
// --------------------------------------------------------------------------
router.get("/sessions/conflicts", requireAuth, async (req, res) => {
    const startParam = String(req.query.start || "");
    const endParam = req.query.end ? String(req.query.end) : null;

    const startAt = new Date(startParam);
    const endAt = endParam ? new Date(endParam) : null;

    if (Number.isNaN(startAt.getTime())) {
        return res.status(400).json({ error: "start is required (ISO datetime)" });
    }
    if (endParam && Number.isNaN(endAt.getTime())) {
        return res.status(400).json({ error: "end must be a valid ISO datetime" });
    }

    const userId = req.query.userId ? Number(req.query.userId) : null;
    const teacherId = req.query.teacherId ? Number(req.query.teacherId) : null;
    const excludeId = req.query.excludeId
        ? Number(req.query.excludeId)
        : undefined;

    try {
        const conflicts = await findSessionConflicts({
            startAt,
            endAt,
            userId,
            teacherId,
            excludeId,
        });
        res.json({ conflicts });
    } catch (e) {
        logger.error({ err: e }, "conflicts endpoint error");
        res.status(500).json({ error: "Failed to check conflicts" });
    }
});

export default router;
