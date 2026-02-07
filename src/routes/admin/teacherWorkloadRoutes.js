import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { logger } from "../../lib/logger.js";

const router = Router();

router.get("/admin/teachers/workload", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { teacherId = "", from = "", to = "" } = req.query;

    const now = new Date();
    const fromDate = from
      ? new Date(String(from))
      : new Date(now.getTime() - 30 * 86400000);
    const toDate = to ? new Date(String(to)) : now;

    if (Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'from' date" });
    }
    if (Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'to' date" });
    }

    const toExclusive = new Date(toDate.getTime() + 86400000);

    const where = {
      status: { in: ["scheduled", "completed"] },
      startAt: { gte: fromDate, lt: toExclusive },
      ...(teacherId ? { teacherId: Number(teacherId) } : {}),
    };

    const sessions = await prisma.session.findMany({
      where,
      select: {
        id: true,
        teacherId: true,
        startAt: true,
        endAt: true,
        status: true,
      },
    });

    const agg = new Map();
    for (const s of sessions) {
      if (!s.teacherId) continue;

      const start = s.startAt ? new Date(s.startAt) : null;
      const end = s.endAt ? new Date(s.endAt) : null;

      let minutes = 60;
      if (
        start &&
        end &&
        !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime())
      ) {
        const diffMs = end.getTime() - start.getTime();
        if (diffMs > 0) minutes = Math.round(diffMs / 60000);
      }

      if (!agg.has(s.teacherId)) {
        agg.set(s.teacherId, {
          sessions: 0,
          minutes: 0,
          completedSessions: 0,
          completedMinutes: 0,
        });
      }
      const a = agg.get(s.teacherId);
      a.sessions += 1;
      a.minutes += minutes;

      if (s.status === "completed") {
        a.completedSessions += 1;
        a.completedMinutes += minutes;
      }
    }

    const teacherIds = Array.from(agg.keys());
    if (teacherIds.length === 0) return res.json([]);

    const teachers = await prisma.user.findMany({
      where: { id: { in: teacherIds } },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        rateHourlyCents: true,
        ratePerSessionCents: true,
      },
    });

    const rows = teachers
      .filter((t) => t.role === "teacher" || t.role === "admin")
      .map((t) => {
        const a = agg.get(t.id) || {
          sessions: 0,
          minutes: 0,
          completedSessions: 0,
          completedMinutes: 0,
        };

        const hours = Number((a.minutes / 60).toFixed(2));
        const completedHours = Number((a.completedMinutes / 60).toFixed(2));

        let method = "none";
        let payrollAppliedUSD = 0;
        let rateHourlyCents = 0;

        if (typeof t.rateHourlyCents === "number" && t.rateHourlyCents > 0) {
          method = "hourly";
          rateHourlyCents = t.rateHourlyCents;
          payrollAppliedUSD = Number(((completedHours * t.rateHourlyCents) / 100).toFixed(2));
        } else if (
          typeof t.ratePerSessionCents === "number" &&
          t.ratePerSessionCents > 0
        ) {
          method = "per_session";
          payrollAppliedUSD = Number(
            ((a.completedSessions * t.ratePerSessionCents) / 100).toFixed(2)
          );

          const avgSessionHours =
            a.completedSessions > 0 ? completedHours / a.completedSessions : 1;
          const derivedHourly =
            avgSessionHours > 0 ? t.ratePerSessionCents / avgSessionHours : 0;
          rateHourlyCents = Math.round(derivedHourly);
        }

        return {
          teacher: { id: t.id, name: t.name || "", email: t.email },
          sessions: a.sessions,
          hours,
          rateHourlyCents,
          payrollAppliedUSD,
          method,
        };
      })
      .sort((x, y) => y.hours - x.hours);

    return res.json(rows);
  } catch (err) {
    logger.error({ err }, "admin.teachersWorkload error");
    return res.status(500).json({ error: "Failed to load workload data" });
  }
});

export default router;
