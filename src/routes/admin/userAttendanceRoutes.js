import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";

const router = Router();

router.get(
  "/admin/users/:userId/attendance",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUserId = parseInt(req.params.userId, 10);
      if (!targetUserId) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const learner = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, name: true, email: true, createdAt: true },
      });
      if (!learner) return res.status(404).json({ error: "User not found" });

      const attendanceRecords = await prisma.sessionParticipant.findMany({
        where: {
          userId: targetUserId,
          session: { status: { in: ["completed", "scheduled"] } },
        },
        include: {
          session: {
            select: {
              id: true,
              title: true,
              startAt: true,
              endAt: true,
              status: true,
              type: true,
              teacher: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: { session: { startAt: "desc" } },
      });

      const nonCanceled = attendanceRecords.filter((r) => r.status !== "canceled");

      const stats = {
        totalSessions: nonCanceled.length,
        attended: nonCanceled.filter((r) => r.status === "attended").length,
        noShow: nonCanceled.filter((r) => r.status === "no_show").length,
        excused: nonCanceled.filter((r) => r.status === "excused").length,
        upcoming: nonCanceled.filter(
          (r) =>
            r.status === "booked" &&
            r.session?.startAt &&
            new Date(r.session.startAt) > new Date()
        ).length,
        canceled: attendanceRecords.filter((r) => r.status === "canceled").length,
      };

      const gradedSessions = stats.attended + stats.noShow + stats.excused;
      stats.attendanceRate =
        gradedSessions > 0
          ? Math.round(((stats.attended + stats.excused) / gradedSessions) * 100)
          : null;

      const history = attendanceRecords.map((r) => ({
        id: r.id,
        sessionId: r.session?.id,
        sessionTitle: r.session?.title || "Session",
        sessionDate: r.session?.startAt,
        sessionEndDate: r.session?.endAt,
        sessionStatus: r.session?.status,
        sessionType: r.session?.type,
        teacherName:
          r.session?.teacher?.name || r.session?.teacher?.email || "Unassigned",
        teacherId: r.session?.teacher?.id,
        status: r.status,
        attendedAt: r.attendedAt,
      }));

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const monthlyData = {};
      nonCanceled
        .filter((r) => r.session?.startAt && new Date(r.session.startAt) >= sixMonthsAgo)
        .forEach((r) => {
          const month = new Date(r.session.startAt).toISOString().slice(0, 7);
          if (!monthlyData[month]) {
            monthlyData[month] = {
              total: 0,
              attended: 0,
              noShow: 0,
              excused: 0,
            };
          }
          monthlyData[month].total++;
          if (r.status === "attended") monthlyData[month].attended++;
          if (r.status === "no_show") monthlyData[month].noShow++;
          if (r.status === "excused") monthlyData[month].excused++;
        });

      const monthlyBreakdown = Object.entries(monthlyData)
        .map(([month, data]) => ({
          month,
          ...data,
          attendanceRate:
            data.attended + data.noShow + data.excused > 0
              ? Math.round(
                  ((data.attended + data.excused) /
                    (data.attended + data.noShow + data.excused)) *
                    100
                )
              : null,
        }))
        .sort((a, b) => a.month.localeCompare(b.month));

      return res.json({
        learner: {
          id: learner.id,
          name: learner.name,
          email: learner.email,
          memberSince: learner.createdAt,
        },
        stats,
        history,
        monthlyBreakdown,
      });
    } catch (err) {
      console.error("Attendance route error:", err);
      return res.status(500).json({ error: "Failed to fetch attendance data" });
    }
  }
);

export default router;
