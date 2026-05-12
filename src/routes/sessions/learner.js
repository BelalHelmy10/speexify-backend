// src/routes/sessions/learner.js
// Learner session endpoints: /me/sessions, /me/sessions-between, /me/progress

import {
    Router,
    prisma,
    requireAuth,
    finalizeExpiredSessionsForUser,
    logger,
} from "./_shared.js";

const router = Router();
const SESSION_LIST_DEFAULT_LIMIT = 10;
const SESSION_LIST_MAX_LIMIT = 100;
const SESSIONS_BETWEEN_DEFAULT_LIMIT = 500;
const SESSIONS_BETWEEN_MAX_LIMIT = 1000;

function parseBoundedInt(value, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function getSessionMinutes(session) {
    const start = session?.startAt ? new Date(session.startAt) : null;
    const end = session?.endAt ? new Date(session.endAt) : null;

    if (
        !start ||
        !end ||
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime())
    ) {
        return 0;
    }

    const diff = end.getTime() - start.getTime();
    return diff > 0 ? Math.round(diff / 1000 / 60) : 0;
}

function getMonthKey(date) {
    const value = date ? new Date(date) : null;
    if (!value || Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function getWeekStartTime(date) {
    const value = date ? new Date(date) : null;
    if (!value || Number.isNaN(value.getTime())) return null;

    value.setHours(0, 0, 0, 0);
    const dayFromMonday = (value.getDay() + 6) % 7;
    value.setDate(value.getDate() - dayFromMonday);
    return value.getTime();
}

function calculateWeeklyStreaks(sessions) {
    const weekStarts = Array.from(
        new Set(
            (sessions || [])
                .map((session) => getWeekStartTime(session.startAt))
                .filter((value) => Number.isFinite(value))
        )
    ).sort((a, b) => a - b);

    if (weekStarts.length === 0) {
        return { currentStreak: 0, longestStreak: 0 };
    }

    const weekSet = new Set(weekStarts);
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    let longestStreak = 1;
    let runningStreak = 1;

    for (let i = 1; i < weekStarts.length; i += 1) {
        if (weekStarts[i] - weekStarts[i - 1] === oneWeekMs) {
            runningStreak += 1;
        } else {
            runningStreak = 1;
        }
        longestStreak = Math.max(longestStreak, runningStreak);
    }

    let currentStreak = 0;
    let cursor = weekStarts[weekStarts.length - 1];
    while (weekSet.has(cursor)) {
        currentStreak += 1;
        cursor -= oneWeekMs;
    }

    return { currentStreak, longestStreak };
}

function parseResourcesUsed(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function getTeacherFeedback(session) {
    const feedback = session?.feedback;
    if (!feedback) return null;

    const messageToLearner = feedback.messageToLearner || "";
    const commentsOnSession = feedback.commentsOnSession || "";
    const futureSteps = feedback.futureSteps || "";

    if (!messageToLearner && !commentsOnSession && !futureSteps) return null;

    return {
        id: feedback.id,
        messageToLearner,
        commentsOnSession,
        futureSteps,
    };
}

function buildNextMilestone(totalCompletedSessions) {
    const targets = [
        { target: 1, label: "First session completed" },
        { target: 3, label: "Momentum builder" },
        { target: 5, label: "Five-session foundation" },
        { target: 10, label: "Ten-session commitment" },
        { target: 20, label: "Long-term communicator" },
    ];

    const milestone =
        targets.find((item) => totalCompletedSessions < item.target) || {
            target: Math.ceil((totalCompletedSessions + 1) / 10) * 10,
            label: "Next mastery checkpoint",
        };

    return {
        ...milestone,
        progress: Math.min(totalCompletedSessions, milestone.target),
        remaining: Math.max(0, milestone.target - totalCompletedSessions),
    };
}

function buildSkillGrowth({
    totalCompletedSessions,
    totalMinutes,
    attendanceRate,
    feedbackReceivedCount,
    packageCompletionPercent,
}) {
    const feedbackRate =
        totalCompletedSessions > 0
            ? Math.round((feedbackReceivedCount / totalCompletedSessions) * 100)
            : 0;

    return [
        {
            key: "fluency-practice",
            label: "Fluency practice",
            score: Math.min(100, Math.round(20 + totalCompletedSessions * 7 + totalMinutes / 18)),
            source: "Based on completed speaking time",
        },
        {
            key: "consistency",
            label: "Consistency",
            score:
                attendanceRate != null
                    ? attendanceRate
                    : Math.min(100, Math.round(totalCompletedSessions * 12)),
            source: "Based on attendance and completed sessions",
        },
        {
            key: "feedback-loop",
            label: "Feedback loop",
            score: Math.min(100, feedbackRate),
            source: "Based on sessions with teacher feedback",
        },
        {
            key: "course-progress",
            label: "Course progress",
            score: Math.min(100, Math.round(packageCompletionPercent || 0)),
            source: "Based on active package usage",
        },
    ];
}

function buildAchievements({
    totalCompletedSessions,
    totalMinutes,
    currentStreak,
    feedbackReceivedCount,
    attendanceRate,
    packageCompletionPercent,
}) {
    return [
        {
            key: "first-session",
            title: "First session",
            description: "Complete your first live coaching session.",
            earned: totalCompletedSessions >= 1,
            progress: Math.min(totalCompletedSessions, 1),
            target: 1,
        },
        {
            key: "momentum-builder",
            title: "Momentum builder",
            description: "Complete sessions across 3 consecutive learning weeks.",
            earned: currentStreak >= 3,
            progress: Math.min(currentStreak, 3),
            target: 3,
        },
        {
            key: "five-hours",
            title: "Five hours practiced",
            description: "Reach 300 minutes of guided speaking practice.",
            earned: totalMinutes >= 300,
            progress: Math.min(totalMinutes, 300),
            target: 300,
        },
        {
            key: "feedback-loop",
            title: "Feedback loop",
            description: "Receive teacher feedback on 3 completed sessions.",
            earned: feedbackReceivedCount >= 3,
            progress: Math.min(feedbackReceivedCount, 3),
            target: 3,
        },
        {
            key: "halfway",
            title: "Halfway there",
            description: "Use at least half of your active learning package.",
            earned: packageCompletionPercent >= 50,
            progress: Math.min(Math.round(packageCompletionPercent || 0), 50),
            target: 50,
        },
        {
            key: "reliable-learner",
            title: "Reliable learner",
            description: "Keep perfect attendance after at least 3 completed sessions.",
            earned: totalCompletedSessions >= 3 && attendanceRate === 100,
            progress:
                totalCompletedSessions >= 3 && attendanceRate != null
                    ? Math.min(attendanceRate, 100)
                    : Math.min(totalCompletedSessions, 3),
            target: totalCompletedSessions >= 3 ? 100 : 3,
        },
    ];
}

function buildNextAction({ nextSession, latestCompletedSession, activeCourse, totalCompletedSessions }) {
    if (nextSession) {
        return {
            type: "prepare",
            label: "Prepare for your next session",
            description: `${nextSession.title || "Your next session"} is the best place to keep your momentum moving.`,
            href: `/dashboard/sessions/${nextSession.id}`,
            sessionId: nextSession.id,
        };
    }

    if (latestCompletedSession?.teacherFeedback) {
        return {
            type: "review-feedback",
            label: "Review your latest teacher feedback",
            description: "Turn your teacher's notes into one concrete improvement before the next session.",
            href: `/dashboard/sessions/${latestCompletedSession.id}`,
            sessionId: latestCompletedSession.id,
        };
    }

    if ((activeCourse?.remainingSessions || 0) > 0) {
        return {
            type: "schedule",
            label: "Schedule your next session",
            description:
                totalCompletedSessions > 0
                    ? "You still have learning credits ready. Book the next step while the rhythm is fresh."
                    : "Start your first live session and unlock your progress timeline.",
            href: "/calendar",
        };
    }

    return {
        type: "package",
        label: "Choose your next learning package",
        description: "Add session credits to keep your learning path active.",
        href: "/packages",
    };
}

// --------------------------------------------------------------------------
// GET /api/me/sessions - List sessions for current user
// --------------------------------------------------------------------------
router.get("/me/sessions", requireAuth, async (req, res) => {
    try {
        // ✅ Admin dashboard should not use "my sessions"
        // BUT allow if admin is impersonating another user
        if (req.user.role === "admin" && !req.session?.asUserId) {
            return res.json([]);
        }

        // Best-effort finalization, don't break if it fails
        try {
            await finalizeExpiredSessionsForUser(req.viewUserId);
        } catch (e) {
            logger.error(
                { err: e, userId: req.viewUserId },
                "finalizeExpiredSessionsForUser failed"
            );
        }

        const userId = req.viewUserId;
        // When impersonating, get the impersonated user's role, not admin's role
        const isImpersonating = !!req.session?.asUserId;
        let role = req.user.role || "learner";

        // If impersonating, fetch the impersonated user's role
        if (isImpersonating && req.session.asUserId) {
            const impersonatedUser = await prisma.user.findUnique({
                where: { id: req.session.asUserId },
                select: { role: true },
            });
            if (impersonatedUser) {
                role = impersonatedUser.role;
            }
        }
        const { range = "upcoming" } = req.query;
        const requestedLimit = parseBoundedInt(req.query.limit, {
            fallback: SESSION_LIST_DEFAULT_LIMIT,
            min: 1,
            max: SESSION_LIST_MAX_LIMIT,
        });
        const now = new Date();

        // Membership base: include both participants AND legacy userId
        const whereBase =
            role === "teacher"
                ? {
                    OR: [
                        { teacherId: userId },
                        { participants: { some: { userId } } },
                        { userId }, // legacy fallback
                    ],
                }
                : {
                    OR: [
                        { participants: { some: { userId } } },
                        { userId }, // legacy fallback
                    ],
                };

        const notCanceled = { status: { not: "canceled" } };

        const inProgressOrFuture = {
            OR: [
                { startAt: { gte: now } },
                {
                    AND: [
                        { startAt: { lte: now } },
                        { OR: [{ endAt: { gte: now } }, { endAt: null }] },
                    ],
                },
            ],
        };

        const pastCondition = {
            OR: [
                { endAt: { lt: now } },
                { AND: [{ endAt: null }, { startAt: { lt: now } }] },
            ],
        };

        const where =
            range === "past"
                ? { AND: [whereBase, pastCondition] }
                : { AND: [whereBase, notCanceled, inProgressOrFuture] };

        const orderBy = range === "past" ? { startAt: "desc" } : { startAt: "asc" };

        const rawSessions = await prisma.session.findMany({
            where,
            orderBy,
            take: requestedLimit,
            select: {
                id: true,
                title: true,
                startAt: true,
                endAt: true,
                joinUrl: true,
                status: true,
                type: true,
                capacity: true,
                teacherId: true,
                userId: true,
                teacher: { select: { id: true, name: true, email: true } },
                user: { select: { id: true, name: true, email: true } },
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        user: { select: { id: true, name: true, email: true } },
                    },
                },
                teacherFeedbackMessageToLearner: true,
                teacherFeedbackComments: true,
                teacherFeedbackFutureSteps: true,
                feedback: { select: { id: true } },
            },
        });

        const sessions = rawSessions.map((s) => {
            const hasFeedback =
                !!s.feedback ||
                !!s.teacherFeedbackMessageToLearner ||
                !!s.teacherFeedbackComments ||
                !!s.teacherFeedbackFutureSteps;

            const teacherFeedback = hasFeedback
                ? {
                    messageToLearner: s.teacherFeedbackMessageToLearner || "",
                    commentsOnSession: s.teacherFeedbackComments || "",
                    futureSteps: s.teacherFeedbackFutureSteps || "",
                }
                : null;

            const {
                teacherFeedbackMessageToLearner,
                teacherFeedbackComments,
                teacherFeedbackFutureSteps,
                feedback,
                ...rest
            } = s;

            const activeParticipants = (rest.participants || []).filter(
                (p) => p.status !== "canceled"
            );

            return {
                ...rest,
                participantCount: activeParticipants.length,
                // For GROUP sessions, include learner list
                learners:
                    rest.type === "GROUP"
                        ? activeParticipants.map((p) => p.user)
                        : rest.user
                            ? [rest.user]
                            : [],
                teacherFeedback,
                hasFeedback,
            };
        });

        res.json(sessions);
    } catch (e) {
        logger.error({ err: e }, "GET /me/sessions failed");
        res.status(500).json({ error: "Failed to load sessions" });
    }
});

// --------------------------------------------------------------------------
// GET /api/me/sessions-between - Get sessions in date range (calendar)
// --------------------------------------------------------------------------
router.get("/me/sessions-between", requireAuth, async (req, res) => {
    try {
        const startParam = String(req.query.start || "");
        const endParam = String(req.query.end || "");
        const includeCanceled = String(req.query.includeCanceled || "") === "true";

        const startAt = new Date(startParam);
        const endAt = new Date(endParam);

        if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
            return res.status(400).json({ error: "Invalid date range" });
        }

        const userId = req.viewUserId;

        // When impersonating, get the impersonated user's role, not admin's role
        const isImpersonating = !!req.session?.asUserId;
        let role = req.user.role || "learner";

        if (isImpersonating && req.session.asUserId) {
            const impersonatedUser = await prisma.user.findUnique({
                where: { id: req.session.asUserId },
                select: { role: true },
            });
            if (impersonatedUser) {
                role = impersonatedUser.role;
            }
        }

        const whereBase =
            role === "teacher"
                ? {
                    OR: [
                        { teacherId: userId },
                        { participants: { some: { userId } } },
                        { userId }, // legacy
                    ],
                }
                : {
                    OR: [{ participants: { some: { userId } } }, { userId }],
                };

        const where = {
            AND: [
                whereBase,
                includeCanceled ? {} : { status: { not: "canceled" } },
                { startAt: { lte: endAt } },
                { OR: [{ endAt: { gte: startAt } }, { endAt: null }] },
            ],
        };

        const requestedLimit = parseBoundedInt(req.query.limit, {
            fallback: SESSIONS_BETWEEN_DEFAULT_LIMIT,
            min: 1,
            max: SESSIONS_BETWEEN_MAX_LIMIT,
        });

        const sessions = await prisma.session.findMany({
            where,
            orderBy: { startAt: "asc" },
            take: requestedLimit,
            select: {
                id: true,
                title: true,
                startAt: true,
                endAt: true,
                joinUrl: true,
                status: true,
                type: true,
                capacity: true,
                feedback: { select: { id: true } },
                participants: {
                    select: { userId: true, status: true },
                },
            },
        });

        const shaped = sessions.map((s) => {
            const activeCount = (s.participants || []).filter(
                (p) => p.status !== "canceled"
            ).length;

            return {
                ...s,
                participantCount: activeCount,
                teacherFeedback: s.feedback,
            };
        });

        return res.json({
            sessions: shaped,
            truncated: sessions.length === requestedLimit,
        });
    } catch (e) {
        logger.error({ err: e }, "GET /me/sessions-between failed");
        return res.status(500).json({
            error: e?.message || e?.meta?.cause || "Failed to load calendar sessions",
        });
    }
});

// --------------------------------------------------------------------------
// GET /api/me/progress - Learner progress summary
// --------------------------------------------------------------------------
router.get("/me/progress", requireAuth, async (req, res) => {
    try {
        const userId = req.viewUserId || req.user.id;
        const now = new Date();
        const learnerSessionWhere = {
            OR: [{ participants: { some: { userId } } }, { userId }],
        };

        const [completedSessions, activePackagesRaw, nextSession] =
            await Promise.all([
                prisma.session.findMany({
                    where: {
                        status: "completed",
                        ...learnerSessionWhere,
                    },
                    orderBy: { startAt: "asc" },
                    select: {
                        id: true,
                        title: true,
                        startAt: true,
                        endAt: true,
                        userId: true,
                        type: true,
                        resourcesUsed: true,
                        teacher: { select: { id: true, name: true, email: true } },
                        participants: {
                            where: { userId },
                            select: { status: true, attendedAt: true },
                        },
                        feedback: {
                            select: {
                                id: true,
                                messageToLearner: true,
                                commentsOnSession: true,
                                futureSteps: true,
                            },
                        },
                        learnerFeedbacks: {
                            where: { learnerId: userId },
                            select: {
                                rating: true,
                                highlights: true,
                                improvements: true,
                                otherFeedback: true,
                                updatedAt: true,
                            },
                        },
                    },
                }),
                prisma.userPackage.findMany({
                    where: { userId, status: "active" },
                    orderBy: { createdAt: "desc" },
                    select: {
                        id: true,
                        title: true,
                        minutesPerSession: true,
                        sessionsTotal: true,
                        sessionsUsed: true,
                        expiresAt: true,
                        status: true,
                        createdAt: true,
                    },
                }),
                prisma.session.findFirst({
                    where: {
                        status: "scheduled",
                        startAt: { gte: now },
                        ...learnerSessionWhere,
                    },
                    orderBy: { startAt: "asc" },
                    select: {
                        id: true,
                        title: true,
                        startAt: true,
                        endAt: true,
                        type: true,
                        teacher: { select: { id: true, name: true, email: true } },
                    },
                }),
            ]);

        const activePackages = activePackagesRaw.filter((pack) => {
            if (!pack.expiresAt) return true;
            return new Date(pack.expiresAt).getTime() >= now.getTime();
        });

        const packageSessionsTotal = activePackages.reduce(
            (sum, pack) => sum + Number(pack.sessionsTotal || 0),
            0
        );
        const packageSessionsUsed = activePackages.reduce(
            (sum, pack) => sum + Number(pack.sessionsUsed || 0),
            0
        );
        const packageSessionsRemaining = Math.max(
            0,
            packageSessionsTotal - packageSessionsUsed
        );
        const packageCompletionPercent =
            packageSessionsTotal > 0
                ? Math.min(
                    100,
                    Math.round((packageSessionsUsed / packageSessionsTotal) * 100)
                )
                : 0;

        const primaryPackage = activePackages[0] || null;
        const activeCourse = {
            title:
                activePackages.length > 1
                    ? `${activePackages.length} active packages`
                    : primaryPackage?.title || "Learning package",
            totalSessions: packageSessionsTotal,
            usedSessions: packageSessionsUsed,
            remainingSessions: packageSessionsRemaining,
            completedSessions:
                packageSessionsTotal > 0
                    ? Math.min(completedSessions.length, packageSessionsTotal)
                    : completedSessions.length,
            completionPercent: packageCompletionPercent,
            minutesPerSession: primaryPackage?.minutesPerSession || null,
            expiresAt: primaryPackage?.expiresAt || null,
            hasActivePackage: activePackages.length > 0,
        };

        const totalCompletedSessions = completedSessions.length;
        const totalMinutes = completedSessions.reduce(
            (sum, session) => sum + getSessionMinutes(session),
            0
        );
        const totalHours = Number((totalMinutes / 60).toFixed(1));
        const currentMonthKey = getMonthKey(now);
        const sessionsThisMonth = completedSessions.filter(
            (session) => getMonthKey(session.startAt) === currentMonthKey
        );
        const minutesThisMonth = sessionsThisMonth.reduce(
            (sum, session) => sum + getSessionMinutes(session),
            0
        );

        const monthCounts = new Map();
        const resourceIds = new Set();
        const attendanceRows = [];
        const ratings = [];
        const learningPathAsc = [];

        for (const session of completedSessions) {
            const month = getMonthKey(session.startAt);
            if (month) {
                monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
            }

            const resourcesUsed = parseResourcesUsed(session.resourcesUsed);
            resourcesUsed.forEach((resource, index) => {
                const resourceKey =
                    resource?.id ||
                    resource?._id ||
                    resource?.resourceId ||
                    resource?.title ||
                    `${session.id}-${index}`;
                resourceIds.add(String(resourceKey));
            });

            const participant = session.participants?.[0] || null;
            if (participant) {
                attendanceRows.push(participant);
            } else if (session.userId === userId) {
                attendanceRows.push({ status: "attended", attendedAt: session.endAt });
            }

            const learnerFeedback = session.learnerFeedbacks?.[0] || null;
            if (learnerFeedback?.rating) {
                ratings.push(Number(learnerFeedback.rating));
            }

            const teacherFeedback = getTeacherFeedback(session);
            learningPathAsc.push({
                id: session.id,
                title: session.title || "Session",
                startAt: session.startAt,
                endAt: session.endAt,
                durationMinutes: getSessionMinutes(session),
                type: session.type,
                teacherName: session.teacher?.name || session.teacher?.email || null,
                attendanceStatus: participant?.status || "attended",
                materialsCount: resourcesUsed.length,
                hasTeacherFeedback: !!teacherFeedback,
                teacherFeedback,
                learnerRating: learnerFeedback?.rating || null,
                learnerFeedback,
                href: `/dashboard/sessions/${session.id}`,
            });
        }

        const gradedAttendance = attendanceRows.filter((row) =>
            ["attended", "no_show", "excused"].includes(row.status)
        );
        const positiveAttendance = gradedAttendance.filter((row) =>
            ["attended", "excused"].includes(row.status)
        );
        const attendanceRate =
            gradedAttendance.length > 0
                ? Math.round((positiveAttendance.length / gradedAttendance.length) * 100)
                : totalCompletedSessions > 0
                    ? 100
                    : null;

        const averageRating =
            ratings.length > 0
                ? Number(
                    (ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(1)
                )
                : null;

        const feedbackReceivedCount = learningPathAsc.filter(
            (session) => session.hasTeacherFeedback
        ).length;
        const { currentStreak, longestStreak } = calculateWeeklyStreaks(completedSessions);
        const nextMilestone = buildNextMilestone(totalCompletedSessions);

        const timeline = Array.from(monthCounts.entries())
            .map(([month, count]) => ({ month, count }))
            .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
            .slice(-12);

        const learningPath = [...learningPathAsc]
            .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
            .slice(0, 8);

        const latestCompletedSession = learningPath[0] || null;
        const shapedNextSession = nextSession
            ? {
                id: nextSession.id,
                title: nextSession.title || "Session",
                startAt: nextSession.startAt,
                endAt: nextSession.endAt,
                type: nextSession.type,
                teacherName:
                    nextSession.teacher?.name || nextSession.teacher?.email || null,
                href: `/dashboard/sessions/${nextSession.id}`,
            }
            : null;

        const nextAction = buildNextAction({
            nextSession: shapedNextSession,
            latestCompletedSession,
            activeCourse,
            totalCompletedSessions,
        });

        const missions = [
            latestCompletedSession?.teacherFeedback?.futureSteps
                ? {
                    key: "teacher-next-step",
                    title: "Teacher focus",
                    description: latestCompletedSession.teacherFeedback.futureSteps,
                    href: latestCompletedSession.href,
                }
                : null,
            shapedNextSession
                ? {
                    key: "prepare-next-session",
                    title: "Prepare next session",
                    description: `${shapedNextSession.title} is scheduled next. Review your last notes before joining.`,
                    href: shapedNextSession.href,
                }
                : null,
            totalCompletedSessions === 0
                ? {
                    key: "first-session",
                    title: "Start your progress timeline",
                    description:
                        "Complete your first coaching session to unlock milestones, streaks, and feedback history.",
                    href: shapedNextSession?.href || "/calendar",
                }
                : null,
            activeCourse.remainingSessions > 0 && !shapedNextSession
                ? {
                    key: "schedule-next",
                    title: "Keep the rhythm",
                    description: "You have session credits ready. Put the next session on your calendar.",
                    href: "/calendar",
                }
                : null,
        ].filter(Boolean).slice(0, 3);

        const skillGrowth = buildSkillGrowth({
            totalCompletedSessions,
            totalMinutes,
            attendanceRate,
            feedbackReceivedCount,
            packageCompletionPercent,
        });

        const achievements = buildAchievements({
            totalCompletedSessions,
            totalMinutes,
            currentStreak,
            feedbackReceivedCount,
            attendanceRate,
            packageCompletionPercent,
        });

        return res.json({
            summary: {
                totalCompletedSessions,
                sessionsThisMonth: sessionsThisMonth.length,
                totalMinutes: Math.round(totalMinutes),
                totalHours,
                minutesThisMonth,
                averageRating,
                attendanceRate,
                feedbackReceivedCount,
                resourcesCoveredCount: resourceIds.size,
                currentStreak,
                longestStreak,
                nextMilestone,
            },
            course: activeCourse,
            nextSession: shapedNextSession,
            nextAction,
            missions,
            skillGrowth,
            achievements,
            learningPath,
            timeline,
        });
    } catch (err) {
        logger.error({ err }, "GET /me/progress failed");
        return res
            .status(500)
            .json({ error: err?.message || "Failed to load progress" });
    }
});

export default router;
