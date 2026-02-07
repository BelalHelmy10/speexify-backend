// src/routes/admin.js
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import crypto from "node:crypto";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { logger } from "../lib/logger.js";
import { sendEmail } from "../services/emailService.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

async function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    await prisma.audit.create({
      data: { actorId, action, entity, entityId, meta },
    });
  } catch (e) {
    logger.error({ err: e }, "audit failed");
  }
}

/* ========================================================================== */
/*                                ADMIN: USERS                                */
/* ========================================================================== */

router.get(
  "/admin/users",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { q = "", role = "" } = req.query;
      const where = {};

      if (q) {
        where.OR = [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ];
      }
      if (role) where.role = String(role);

      const users = await prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
          createdAt: true,
          rateHourlyCents: true,
          ratePerSessionCents: true,
        },
        orderBy: { id: "asc" },
      });

      res.json(users);
    } catch (err) {
      next(err);
    }
  }
);

router.post("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    let { email, name = "", role = "learner", timezone = null } = req.body;

    email = String(email || "")
      .toLowerCase()
      .trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: "User already exists" });

    const rand = crypto.randomBytes(16).toString("hex");
    const hashedPassword = crypto
      .createHash("sha256")
      .update(rand)
      .digest("hex");

    const user = await prisma.user.create({
      data: { email, name: name || null, role, timezone, hashedPassword },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        timezone: true,
        isDisabled: true,
      },
    });

    const code = genCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    await prisma.passwordResetCode.upsert({
      where: { email },
      update: { codeHash, expiresAt, attempts: 0 },
      create: { email, codeHash, expiresAt, attempts: 0 },
    });

    await sendEmail(
      email,
      "Welcome to Speexify — set your password",
      `<p>Hi${name ? " " + name : ""},</p>
       <p>Your setup code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>Use it on the "Forgot password" page within 10 minutes.</p>`
    );

    await audit(req.user.id, "user_create", "User", user.id, { email, role });
    res.status(201).json({ user });
  } catch (err) {
    logger.error({ err }, "admin.createUser error");
    res.status(500).json({ error: "Failed to create user" });
  }
});

router.patch(
  "/admin/users/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const {
        role,
        isDisabled,
        name,
        timezone,
        rateHourlyCents,
        ratePerSessionCents,
      } = req.body;

      const before = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          role: true,
          isDisabled: true,
          rateHourlyCents: true,
          ratePerSessionCents: true,
        },
      });
      if (!before) return res.status(404).json({ error: "Not found" });

      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(role ? { role } : {}),
          ...(typeof isDisabled === "boolean" ? { isDisabled } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(timezone !== undefined ? { timezone } : {}),

          // ✅ teacher rate fields (allow null to clear)
          ...(rateHourlyCents !== undefined
            ? {
                rateHourlyCents:
                  rateHourlyCents === null || rateHourlyCents === ""
                    ? null
                    : Number.isFinite(Number(rateHourlyCents))
                    ? Number(rateHourlyCents)
                    : null,
              }
            : {}),
          ...(ratePerSessionCents !== undefined
            ? {
                ratePerSessionCents:
                  ratePerSessionCents === null || ratePerSessionCents === ""
                    ? null
                    : Number.isFinite(Number(ratePerSessionCents))
                    ? Number(ratePerSessionCents)
                    : null,
              }
            : {}),
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
          rateHourlyCents: true,
          ratePerSessionCents: true,
        },
      });

      if (role && role !== before.role) {
        await audit(req.user.id, "role_change", "User", id, {
          from: before.role,
          to: role,
        });
      }

      if (typeof isDisabled === "boolean" && isDisabled !== before.isDisabled) {
        await audit(
          req.user.id,
          isDisabled ? "user_disable" : "user_enable",
          "User",
          id
        );
      }

      // ✅ Audit rate changes (store from -> to when provided)
      if (rateHourlyCents !== undefined || ratePerSessionCents !== undefined) {
        await audit(req.user.id, "teacher_rate_update", "User", id, {
          from: {
            rateHourlyCents: before.rateHourlyCents,
            ratePerSessionCents: before.ratePerSessionCents,
          },
          to: {
            rateHourlyCents: user.rateHourlyCents,
            ratePerSessionCents: user.ratePerSessionCents,
          },
        });
      }

      res.json(user);
    } catch (err) {
      logger.error({ err }, "admin.patchUser error");
      res.status(500).json({ error: "Failed to update user" });
    }
  }
);

router.post(
  "/admin/users/:id/reset-password",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return res.status(404).json({ error: "Not found" });

      const code = genCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 10 * 60_000);

      await prisma.passwordResetCode.upsert({
        where: { email: user.email },
        update: { codeHash, expiresAt, attempts: 0 },
        create: { email: user.email, codeHash, expiresAt, attempts: 0 },
      });

      await sendEmail(
        user.email,
        "Reset your Speexify password",
        `<p>Hi ${user.name || ""}</p>
       <p>Your reset code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>Use it on the "Forgot password" page within 10 minutes.</p>`
      );

      await audit(req.user.id, "password_reset_send", "User", id);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "admin.resetPassword error");
      res.status(500).json({ error: "Failed to send reset" });
    }
  }
);

/* ========================================================================== */
/*                              ADMIN: IMPERSONATE                            */
/* ========================================================================== */

router.post(
  "/admin/impersonate/stop",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const previousAsUserId = req.session?.asUserId || null;
      req.session.asUserId = null;

      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      if (previousAsUserId) {
        await audit(
          req.user.id,
          "impersonate_stop",
          "User",
          Number(previousAsUserId)
        );
      }

      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "admin.stopImpersonate error");
      return res.status(500).json({ error: "Failed to stop impersonation" });
    }
  }
);

// START route - requires admin
router.post(
  "/admin/impersonate/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);

      if (!targetId || isNaN(targetId)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      if (targetId === req.user.id) {
        return res.status(400).json({ error: "Cannot impersonate yourself" });
      }

      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, isDisabled: true, email: true },
      });

      if (!target || target.isDisabled) {
        return res.status(404).json({ error: "User not found" });
      }

      const previousAsUserId = req.session?.asUserId || null;
      req.session.asUserId = targetId;

      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      await audit(req.user.id, "impersonate_start", "User", targetId, {
        previousAsUserId: previousAsUserId ? Number(previousAsUserId) : null,
      });

      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "admin.startImpersonate error");
      return res.status(500).json({ error: "Failed to start impersonation" });
    }
  }
);

/* ========================================================================== */
/*                          ADMIN: TEACHER WORKLOAD                           */
/* ========================================================================== */

router.get(
  "/admin/teachers/workload",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { teacherId = "", from = "", to = "" } = req.query;

      const now = new Date();

      // Default: last 30 days
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

      // make `to` inclusive
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

      // aggregate by teacherId
      const agg = new Map(); // teacherId -> { sessions, minutes, completedSessions, completedMinutes }
      for (const s of sessions) {
        if (!s.teacherId) continue;

        const start = s.startAt ? new Date(s.startAt) : null;
        const end = s.endAt ? new Date(s.endAt) : null;

        // default duration = 60 mins if endAt missing/invalid
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

          // Payroll should generally be based on COMPLETED sessions only
          const completedHours = Number((a.completedMinutes / 60).toFixed(2));

          let method = "none";
          let payrollAppliedUSD = 0;
          let rateHourlyCents = 0;

          if (typeof t.rateHourlyCents === "number" && t.rateHourlyCents > 0) {
            method = "hourly";
            rateHourlyCents = t.rateHourlyCents;
            payrollAppliedUSD = Number(
              ((completedHours * t.rateHourlyCents) / 100).toFixed(2)
            );
          } else if (
            typeof t.ratePerSessionCents === "number" &&
            t.ratePerSessionCents > 0
          ) {
            method = "per_session";
            payrollAppliedUSD = Number(
              ((a.completedSessions * t.ratePerSessionCents) / 100).toFixed(2)
            );

            // UI expects a rateHourlyCents number; derive it from average completed session length
            const avgSessionHours =
              a.completedSessions > 0
                ? completedHours / a.completedSessions
                : 1; // fallback 1 hour
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
  }
);

/* ========================================================================== */
/*                          ADMIN: USER PACKAGES                              */
/* ========================================================================== */

router.get(
  "/admin/users/:id/packages",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      if (isNaN(userId)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const packages = await prisma.userPackage.findMany({
        where: { userId },
        include: {
          package: {
            select: {
              title: true,
              priceUSD: true,
              sessionsPerPack: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const enhanced = packages.map((p) => ({
        ...p,
        remaining: (p.sessionsTotal || 0) - (p.sessionsUsed || 0),
        packageTitle: p.package?.title || "Custom/Unknown Package",
        packagePriceUSD: p.package?.priceUSD || null,
      }));

      res.json(enhanced);
    } catch (err) {
      logger.error({ err }, "admin.userPackages error");
      res.status(500).json({ error: "Failed to load user packages" });
    }
  }
);

/* ========================================================================== */
/*                         ADMIN: USER ATTENDANCE                             */
/* ========================================================================== */

router.get(
  "/admin/users/:userId/attendance",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const targetUserId = parseInt(req.params.userId, 10);
      if (!targetUserId)
        return res.status(400).json({ error: "Invalid user ID" });

      // learner info
      const learner = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, name: true, email: true, createdAt: true },
      });
      if (!learner) return res.status(404).json({ error: "User not found" });

      // attendance records
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

      const nonCanceled = attendanceRecords.filter(
        (r) => r.status !== "canceled"
      );

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
        canceled: attendanceRecords.filter((r) => r.status === "canceled")
          .length,
      };

      const gradedSessions = stats.attended + stats.noShow + stats.excused;
      stats.attendanceRate =
        gradedSessions > 0
          ? Math.round(
              ((stats.attended + stats.excused) / gradedSessions) * 100
            )
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

      // monthly breakdown (last 6 months)
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const monthlyData = {};
      nonCanceled
        .filter(
          (r) =>
            r.session?.startAt && new Date(r.session.startAt) >= sixMonthsAgo
        )
        .forEach((r) => {
          const month = new Date(r.session.startAt).toISOString().slice(0, 7); // YYYY-MM
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
