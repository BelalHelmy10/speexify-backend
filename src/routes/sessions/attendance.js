// src/routes/sessions/attendance.js
// Attendance marking endpoint

import { Router, prisma, requireAuth, logger } from "./_shared.js";

const router = Router();

// --------------------------------------------------------------------------
// POST /api/sessions/:id/attendance - Mark attendance per participant
// --------------------------------------------------------------------------
router.post("/sessions/:id/attendance", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const { participants } = req.body || {};
        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({ error: "participants[] is required" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                startAt: true,
                teacherId: true,
                status: true,
                type: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!session) return res.status(404).json({ error: "Session not found" });

        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";
        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const now = new Date();
        if (now < new Date(session.startAt)) {
            return res.status(400).json({
                error: "Cannot mark attendance before session starts",
            });
        }

        const allowedStatuses = new Set(["attended", "no_show", "excused"]);

        await prisma.$transaction(async (tx) => {
            for (const p of participants) {
                const uid = Number(p.userId);
                const status = String(p.status);

                if (!uid || !allowedStatuses.has(status)) continue;

                await tx.sessionParticipant.updateMany({
                    where: {
                        sessionId,
                        userId: uid,
                        status: { not: "canceled" },
                    },
                    data: {
                        status,
                        attendedAt: status === "attended" ? new Date() : null,
                    },
                });
            }
        });

        return res.json({ ok: true });
    } catch (e) {
        logger.error({ err: e }, "mark attendance failed");
        return res.status(500).json({ error: "Failed to mark attendance" });
    }
});

export default router;
