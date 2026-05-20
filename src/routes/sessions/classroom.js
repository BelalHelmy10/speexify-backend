// src/routes/sessions/classroom.js
// Classroom experience endpoints: notes, resources, learner feedback, summary

import { Router, prisma, requireAuth, logger } from "./_shared.js";

const router = Router();

const CLASSROOM_FOCUS_MODES = new Set(["video", "balanced", "content"]);
const MIN_SPLIT_PERCENT = 12;
const MAX_SPLIT_PERCENT = 88;
const MAX_CHAT_MESSAGE_LENGTH = 4000;
const CHAT_MESSAGES_DEFAULT_LIMIT = 100;
const CHAT_MESSAGES_MAX_LIMIT = 200;
const CHAT_RATE_LIMIT_MAX = 5;       // max messages per window
const CHAT_RATE_LIMIT_WINDOW_MS = 10000; // 10-second window

// ── In-memory chat rate limiter ──────────────────────────────────────────────
// Key: `${sessionId}:${userId}` → Array of timestamps
const chatRateLimitMap = new Map();

function isChatRateLimited(sessionId, userId) {
    const key = `${sessionId}:${userId}`;
    const now = Date.now();
    const cutoff = now - CHAT_RATE_LIMIT_WINDOW_MS;

    let timestamps = chatRateLimitMap.get(key);
    if (!timestamps) {
        timestamps = [];
        chatRateLimitMap.set(key, timestamps);
    }

    // Remove expired entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
    }

    if (timestamps.length >= CHAT_RATE_LIMIT_MAX) {
        return true;
    }

    timestamps.push(now);
    return false;
}

// Cleanup stale keys every 60 seconds to prevent memory leaks
const chatRateLimitCleanupInterval = setInterval(() => {
    const cutoff = Date.now() - CHAT_RATE_LIMIT_WINDOW_MS * 2;
    for (const [key, timestamps] of chatRateLimitMap) {
        if (!timestamps.length || timestamps[timestamps.length - 1] <= cutoff) {
            chatRateLimitMap.delete(key);
        }
    }
}, 60000);
chatRateLimitCleanupInterval.unref?.();

function parseSessionIdParam(raw) {
    const sessionId = Number(raw);
    if (!sessionId || Number.isNaN(sessionId)) return null;
    return sessionId;
}

function clampNumber(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.min(max, Math.max(min, num));
}

function safeString(value, maxLength = 300) {
    if (value === null) return null;
    if (value === undefined) return undefined;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maxLength);
}

function getStoredClassroomState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
}

function getClassroomAccess(req, session) {
    const viewerId = Number(req.viewUserId);
    const realUserId = Number(req.user?.id);
    const isParticipant = (session.participants || []).some(
        (p) => p.userId === viewerId && p.status !== "canceled"
    );
    const isLearner = isParticipant || session.userId === viewerId;
    const isTeacher = session.teacherId === realUserId;
    const isAdmin = req.user?.role === "admin";

    return { isLearner, isTeacher, isAdmin };
}

function sanitizeLayoutPatch(layout) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) return null;

    const next = {};
    if (layout.focusMode !== undefined) {
        const focusMode = safeString(layout.focusMode, 30);
        if (CLASSROOM_FOCUS_MODES.has(focusMode)) next.focusMode = focusMode;
    }
    if (layout.customSplit !== undefined) {
        next.customSplit =
            layout.customSplit === null
                ? null
                : clampNumber(layout.customSplit, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT);
    }
    if (layout.teacherAllowsFollowing !== undefined) {
        next.teacherAllowsFollowing = Boolean(layout.teacherAllowsFollowing);
    }

    return Object.keys(next).length ? next : null;
}

function sanitizeScrollPatch(scroll) {
    if (!scroll || typeof scroll !== "object" || Array.isArray(scroll)) return null;
    const scrollNorm = clampNumber(scroll.scrollNorm, 0, 1);
    if (scrollNorm === null) return null;

    return {
        resourceId: safeString(scroll.resourceId, 300) ?? null,
        scrollNorm,
        updatedAt: new Date().toISOString(),
    };
}

function sanitizePdfScrollPatch(scroll) {
    if (!scroll || typeof scroll !== "object" || Array.isArray(scroll)) return null;
    const scrollNorm = clampNumber(scroll.scrollNorm, 0, 1);
    if (scrollNorm === null) return null;

    return {
        resourceId: safeString(scroll.resourceId, 300) ?? null,
        page: Math.max(1, Math.floor(Number(scroll.page) || 1)),
        scrollNorm,
        updatedAt: new Date().toISOString(),
    };
}

function sanitizeAudioPatch(audio) {
    if (!audio || typeof audio !== "object" || Array.isArray(audio)) return null;

    const time = clampNumber(audio.time, 0, 24 * 60 * 60);
    const trackIndex = Math.max(0, Math.floor(Number(audio.trackIndex) || 0));
    const seq = Math.max(0, Math.floor(Number(audio.seq) || 0));
    const sentAt = Number(audio.sentAt);

    return {
        resourceId: safeString(audio.resourceId, 300) ?? null,
        seq,
        sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
        trackIndex,
        time: time === null ? 0 : time,
        playing: Boolean(audio.playing),
        updatedAt: new Date().toISOString(),
    };
}

function sanitizeModerationPatch(moderation) {
    if (!moderation || typeof moderation !== "object" || Array.isArray(moderation)) return null;

    const next = {};
    if (moderation.locked !== undefined) {
        next.locked = Boolean(moderation.locked);
    }
    if (moderation.lobbyEnabled !== undefined) {
        next.lobbyEnabled = Boolean(moderation.lobbyEnabled);
    }

    if (!Object.keys(next).length) return null;

    return {
        ...next,
        updatedAt: new Date().toISOString(),
    };
}

function sanitizeClassroomClientErrorReport(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const location =
        source.location && typeof source.location === "object" && !Array.isArray(source.location)
            ? {
                href: safeString(source.location.href, 1000),
                pathname: safeString(source.location.pathname, 500),
            }
            : null;

    return {
        name: safeString(source.name, 200) || "Error",
        message: safeString(source.message, 2000) || "Unknown classroom client error",
        stack: safeString(source.stack, 12000),
        componentStack: safeString(source.componentStack, 12000),
        userAgent: safeString(source.userAgent, 1000),
        location,
        reportedAt: new Date().toISOString(),
    };
}

function sanitizeClassroomStatePatch(input) {
    const source =
        input?.state && typeof input.state === "object" && !Array.isArray(input.state)
            ? input.state
            : input || {};
    const patch = {};

    if (source.resourceId !== undefined) {
        patch.resourceId = safeString(source.resourceId, 300);
    }

    const layout = sanitizeLayoutPatch(source.layout);
    if (layout) patch.layout = layout;

    const contentScroll = sanitizeScrollPatch(source.contentScroll);
    if (contentScroll) patch.contentScroll = contentScroll;

    const pdfScroll = sanitizePdfScrollPatch(source.pdfScroll);
    if (pdfScroll) patch.pdfScroll = pdfScroll;

    const audio = sanitizeAudioPatch(source.audio);
    if (audio) patch.audio = audio;

    const moderation = sanitizeModerationPatch(source.moderation);
    if (moderation) patch.moderation = moderation;

    return patch;
}

function mergeClassroomState(existingState, patch) {
    const existing = getStoredClassroomState(existingState);
    const nowIso = new Date().toISOString();

    const next = {
        ...existing,
        version: 1,
        updatedAt: nowIso,
    };

    if (patch.resourceId !== undefined) next.resourceId = patch.resourceId;
    if (patch.layout) {
        next.layout = {
            ...(existing.layout && typeof existing.layout === "object"
                ? existing.layout
                : {}),
            ...patch.layout,
            updatedAt: nowIso,
        };
    }
    if (patch.contentScroll) next.contentScroll = patch.contentScroll;
    if (patch.pdfScroll) next.pdfScroll = patch.pdfScroll;
    if (patch.audio) next.audio = patch.audio;
    if (patch.moderation) {
        next.moderation = {
            ...(existing.moderation && typeof existing.moderation === "object"
                ? existing.moderation
                : {}),
            ...patch.moderation,
        };
    }

    return next;
}

function sanitizeChatBody(value) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

function parseChatLimit(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return CHAT_MESSAGES_DEFAULT_LIMIT;
    return Math.min(CHAT_MESSAGES_MAX_LIMIT, Math.max(1, Math.floor(num)));
}

function parseBeforeCursor(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getChatSenderRole(access, userRole) {
    if (access.isTeacher) return "teacher";
    if (access.isAdmin && !access.isLearner) return "admin";
    if (String(userRole || "").toLowerCase() === "teacher") return "teacher";
    return "learner";
}

function getDisplayName(user) {
    return user?.name || user?.email?.split("@")[0] || null;
}

function shapeClassroomMessage(row, access, viewerId) {
    const isDeleted = !!row.deletedAt;
    const isMine = row.senderId != null && Number(row.senderId) === Number(viewerId);
    const canDelete = !isDeleted && (isMine || access.isTeacher || access.isAdmin);

    return {
        id: row.id,
        type: "message",
        role: row.senderRole || "learner",
        name: row.senderName || "Participant",
        text: isDeleted ? "" : row.body,
        at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        senderId: row.senderId,
        isMine,
        isDeleted,
        deletedAt: row.deletedAt ? (row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt) : null,
        canDelete,
        deliveryStatus: "sent",
    };
}

function formatTranscriptLine(row) {
    const at = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
    const name = row.senderName || "Participant";
    const role = row.senderRole ? ` (${row.senderRole})` : "";
    const body = row.deletedAt ? "[deleted message]" : row.body;
    return `[${at}] ${name}${role}: ${body}`;
}

async function findClassroomSession(sessionId) {
    return prisma.session.findUnique({
        where: { id: sessionId },
        select: {
            id: true,
            userId: true,
            teacherId: true,
            classroomState: true,
            participants: {
                select: {
                    userId: true,
                    status: true,
                },
            },
        },
    });
}

async function requireClassroomAccess(req, res, sessionId) {
    const session = await findClassroomSession(sessionId);
    if (!session) {
        res.status(404).json({ error: "Session not found" });
        return null;
    }

    const access = getClassroomAccess(req, session);
    if (!(access.isLearner || access.isTeacher || access.isAdmin)) {
        res.status(403).json({ error: "Forbidden" });
        return null;
    }

    return { session, access };
}

// --------------------------------------------------------------------------
// GET /api/sessions/:id/classroom-state - Restore persisted live classroom state
// --------------------------------------------------------------------------
router.get("/sessions/:id/classroom-state", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await findClassroomSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const { isLearner, isTeacher, isAdmin } = getClassroomAccess(req, session);
        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        return res.json({
            state: getStoredClassroomState(session.classroomState),
        });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/classroom-state failed");
        return res.status(500).json({ error: "Failed to load classroom state" });
    }
});

// --------------------------------------------------------------------------
// PATCH /api/sessions/:id/classroom-state - Persist teacher-controlled live state
// --------------------------------------------------------------------------
router.patch("/sessions/:id/classroom-state", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await findClassroomSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const { isTeacher, isAdmin } = getClassroomAccess(req, session);
        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only the teacher can update classroom state" });
        }

        const patch = sanitizeClassroomStatePatch(req.body || {});
        if (!Object.keys(patch).length) {
            return res.status(400).json({ error: "No valid classroom state fields provided" });
        }

        const nextState = mergeClassroomState(session.classroomState, patch);
        const updated = await prisma.session.update({
            where: { id: sessionId },
            data: { classroomState: nextState },
            select: {
                id: true,
                classroomState: true,
            },
        });

        return res.json({
            ok: true,
            state: getStoredClassroomState(updated.classroomState),
        });
    } catch (err) {
        logger.error({ err }, "PATCH /sessions/:id/classroom-state failed");
        return res.status(500).json({ error: "Failed to save classroom state" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/classroom-error - Report client-side classroom errors
// --------------------------------------------------------------------------
router.post("/sessions/:id/classroom-error", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await findClassroomSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const { isLearner, isTeacher, isAdmin } = getClassroomAccess(req, session);
        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const report = sanitizeClassroomClientErrorReport(req.body || {});
        logger.error(
            {
                sessionId,
                userId: req.user?.id,
                viewUserId: req.viewUserId,
                report,
            },
            "Classroom client render error reported"
        );

        return res.json({ ok: true });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/classroom-error failed");
        return res.status(500).json({ error: "Failed to report classroom error" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/chat/messages - Load persisted classroom chat transcript
// --------------------------------------------------------------------------
router.get("/sessions/:id/chat/messages", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const context = await requireClassroomAccess(req, res, sessionId);
        if (!context) return null;

        const limit = parseChatLimit(req.query.limit);
        const before = parseBeforeCursor(req.query.before);
        const where = {
            sessionId,
            ...(before ? { createdAt: { lt: before } } : {}),
        };

        const rows = await prisma.classroomMessage.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit).reverse();
        const viewerId = Number(req.viewUserId || req.user?.id);

        return res.json({
            ok: true,
            messages: pageRows.map((row) =>
                shapeClassroomMessage(row, context.access, viewerId)
            ),
            hasMore,
            nextBefore: hasMore ? rows[limit - 1]?.createdAt?.toISOString?.() : null,
        });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/chat/messages failed");
        return res.status(500).json({ error: "Failed to load chat messages" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/chat/messages - Persist a classroom chat message
// --------------------------------------------------------------------------
router.post("/sessions/:id/chat/messages", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const context = await requireClassroomAccess(req, res, sessionId);
        if (!context) return null;

        // Rate-limit: max 5 messages per 10 seconds per user per session
        const rateLimitUserId = Number(req.viewUserId || req.user?.id);
        if (Number.isFinite(rateLimitUserId) && isChatRateLimited(sessionId, rateLimitUserId)) {
            return res.status(429).json({
                error: "Too many messages. Please wait a moment before sending again.",
            });
        }

        const rawBody = typeof req.body?.text === "string" ? req.body.text : req.body?.body;
        const body = sanitizeChatBody(rawBody);
        if (!body) {
            return res.status(400).json({ error: "Message cannot be empty" });
        }

        if (String(rawBody || "").trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            return res.status(400).json({
                error: `Message must be ${MAX_CHAT_MESSAGE_LENGTH} characters or less`,
            });
        }

        const senderId = Number(req.viewUserId || req.user?.id);
        const sender = Number.isFinite(senderId)
            ? await prisma.user.findUnique({
                where: { id: senderId },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                },
            })
            : null;

        const row = await prisma.classroomMessage.create({
            data: {
                sessionId,
                senderId: sender?.id || null,
                senderRole: getChatSenderRole(context.access, sender?.role || req.user?.role),
                senderName: getDisplayName(sender) || getDisplayName(req.user) || null,
                body,
            },
        });

        return res.status(201).json({
            ok: true,
            message: shapeClassroomMessage(row, context.access, senderId),
        });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/chat/messages failed");
        return res.status(500).json({ error: "Failed to send chat message" });
    }
});

// --------------------------------------------------------------------------
// DELETE /api/sessions/:id/chat/messages/:messageId - Soft-delete a message
// --------------------------------------------------------------------------
router.delete("/sessions/:id/chat/messages/:messageId", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const context = await requireClassroomAccess(req, res, sessionId);
        if (!context) return null;

        const existing = await prisma.classroomMessage.findFirst({
            where: {
                id: String(req.params.messageId || ""),
                sessionId,
            },
        });

        if (!existing) {
            return res.status(404).json({ error: "Message not found" });
        }

        const viewerId = Number(req.viewUserId || req.user?.id);
        const ownsMessage =
            existing.senderId != null && Number(existing.senderId) === Number(viewerId);

        if (!(ownsMessage || context.access.isTeacher || context.access.isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const row = await prisma.classroomMessage.update({
            where: { id: existing.id },
            data: {
                deletedAt: existing.deletedAt || new Date(),
                deletedById: Number.isFinite(viewerId) ? viewerId : null,
            },
        });

        return res.json({
            ok: true,
            message: shapeClassroomMessage(row, context.access, viewerId),
        });
    } catch (err) {
        logger.error({ err }, "DELETE /sessions/:id/chat/messages/:messageId failed");
        return res.status(500).json({ error: "Failed to delete chat message" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/chat/export - Export classroom transcript as text
// --------------------------------------------------------------------------
router.get("/sessions/:id/chat/export", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const context = await requireClassroomAccess(req, res, sessionId);
        if (!context) return null;

        const rows = await prisma.classroomMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: "asc" },
        });

        const exportedAt = new Date().toISOString();
        const transcript = [
            `Speexify classroom transcript`,
            `Session: ${sessionId}`,
            `Exported: ${exportedAt}`,
            "",
            ...rows.map(formatTranscriptLine),
        ].join("\n");

        return res
            .status(200)
            .set({
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="classroom-chat-${sessionId}.txt"`,
            })
            .send(transcript);
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/chat/export failed");
        return res.status(500).json({ error: "Failed to export chat transcript" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/notes - Save/update teacher notes during session
// --------------------------------------------------------------------------
router.post("/sessions/:id/notes", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                status: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Only teacher or admin can save notes
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only the teacher can save notes" });
        }

        const { notes } = req.body || {};
        const teacherNotes = typeof notes === "string" ? notes.slice(0, 10000) : "";

        const updated = await prisma.session.update({
            where: { id: sessionId },
            data: { teacherNotes },
            select: {
                id: true,
                teacherNotes: true,
                updatedAt: true,
            },
        });

        return res.json({ ok: true, session: updated });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/notes failed");
        return res.status(500).json({ error: "Failed to save notes" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/notes - Get teacher notes for a session
// --------------------------------------------------------------------------
router.get("/sessions/:id/notes", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                userId: true,
                teacherNotes: true,
                participants: { select: { userId: true } },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check permissions
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        return res.json({ notes: session.teacherNotes || "" });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/notes failed");
        return res.status(500).json({ error: "Failed to load notes" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/resources-used - Track resource usage during session
// --------------------------------------------------------------------------
router.post("/sessions/:id/resources-used", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const { resourceId, resourceTitle } = req.body || {};
        if (!resourceId) {
            return res.status(400).json({ error: "resourceId is required" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                status: true,
                resourcesUsed: true,
                resourcesUsedAt: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Only teacher can track resources (they control what's shown)
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res
                .status(403)
                .json({ error: "Only the teacher can track resources" });
        }

        // Parse existing arrays
        let resourcesUsed = [];
        let resourcesUsedAt = {};

        try {
            resourcesUsed = Array.isArray(session.resourcesUsed)
                ? session.resourcesUsed
                : JSON.parse(session.resourcesUsed || "[]");
        } catch {
            resourcesUsed = [];
        }

        try {
            resourcesUsedAt =
                typeof session.resourcesUsedAt === "object" &&
                    session.resourcesUsedAt !== null
                    ? session.resourcesUsedAt
                    : JSON.parse(session.resourcesUsedAt || "{}");
        } catch {
            resourcesUsedAt = {};
        }

        // Add resource if not already tracked
        const resourceEntry = {
            id: String(resourceId),
            title: resourceTitle || null,
            firstOpenedAt: new Date().toISOString(),
        };

        const existingIndex = resourcesUsed.findIndex(
            (r) => r.id === String(resourceId) || r === String(resourceId)
        );

        if (existingIndex === -1) {
            resourcesUsed.push(resourceEntry);
            resourcesUsedAt[String(resourceId)] = new Date().toISOString();
        }

        const updated = await prisma.session.update({
            where: { id: sessionId },
            data: {
                resourcesUsed,
                resourcesUsedAt,
            },
            select: {
                id: true,
                resourcesUsed: true,
                resourcesUsedAt: true,
            },
        });

        return res.json({ ok: true, session: updated });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/resources-used failed");
        return res.status(500).json({ error: "Failed to track resource" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/resources-used - Get resources used in session
// --------------------------------------------------------------------------
router.get("/sessions/:id/resources-used", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                userId: true,
                resourcesUsed: true,
                resourcesUsedAt: true,
                participants: { select: { userId: true } },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check permissions
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        let resourcesUsed = [];
        try {
            resourcesUsed = Array.isArray(session.resourcesUsed)
                ? session.resourcesUsed
                : JSON.parse(session.resourcesUsed || "[]");
        } catch {
            resourcesUsed = [];
        }

        return res.json({ resources: resourcesUsed });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/resources-used failed");
        return res.status(500).json({ error: "Failed to load resources" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/learner-feedback - Submit learner feedback/rating
// --------------------------------------------------------------------------
router.post("/sessions/:id/learner-feedback", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                status: true,
                startAt: true,
                userId: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check if user is a participant
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId && p.status !== "canceled"
        );
        const isLegacyLearner = session.userId === viewerId;

        if (!(isParticipant || isLegacyLearner)) {
            return res
                .status(403)
                .json({ error: "Only session participants can submit feedback" });
        }

        // Only allow feedback after session has started
        const now = new Date();
        if (new Date(session.startAt) > now) {
            return res
                .status(400)
                .json({ error: "Cannot submit feedback before session starts" });
        }

        const { rating, highlights, improvements, otherFeedback } = req.body || {};

        // Validate rating
        const ratingNum = Number(rating);
        if (!rating || Number.isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ error: "Rating must be between 1 and 5" });
        }

        // Upsert feedback (update if exists, create if not)
        const feedback = await prisma.learnerSessionFeedback.upsert({
            where: {
                sessionId_learnerId: {
                    sessionId,
                    learnerId: viewerId,
                },
            },
            update: {
                rating: ratingNum,
                highlights:
                    typeof highlights === "string" ? highlights.slice(0, 2000) : null,
                improvements:
                    typeof improvements === "string" ? improvements.slice(0, 2000) : null,
                otherFeedback:
                    typeof otherFeedback === "string"
                        ? otherFeedback.slice(0, 2000)
                        : null,
            },
            create: {
                sessionId,
                learnerId: viewerId,
                rating: ratingNum,
                highlights:
                    typeof highlights === "string" ? highlights.slice(0, 2000) : null,
                improvements:
                    typeof improvements === "string" ? improvements.slice(0, 2000) : null,
                otherFeedback:
                    typeof otherFeedback === "string"
                        ? otherFeedback.slice(0, 2000)
                        : null,
            },
        });

        // Also update the feedbackScore on the session (average of all ratings)
        const allFeedbacks = await prisma.learnerSessionFeedback.findMany({
            where: { sessionId },
            select: { rating: true },
        });

        if (allFeedbacks.length > 0) {
            const avgRating = Math.round(
                allFeedbacks.reduce((sum, f) => sum + f.rating, 0) / allFeedbacks.length
            );

            await prisma.session.update({
                where: { id: sessionId },
                data: { feedbackScore: avgRating },
            });
        }

        return res.json({ ok: true, feedback });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/learner-feedback failed");
        return res.status(500).json({ error: "Failed to submit feedback" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/learner-feedback - Get learner's own feedback
// --------------------------------------------------------------------------
router.get("/sessions/:id/learner-feedback", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const viewerId = req.viewUserId;

        const feedback = await prisma.learnerSessionFeedback.findUnique({
            where: {
                sessionId_learnerId: {
                    sessionId,
                    learnerId: viewerId,
                },
            },
        });

        return res.json({ feedback: feedback || null });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/learner-feedback failed");
        return res.status(500).json({ error: "Failed to load feedback" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/all-learner-feedback - Get all feedback (teacher/admin only)
// --------------------------------------------------------------------------
router.get(
    "/sessions/:id/all-learner-feedback",
    requireAuth,
    async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            if (!sessionId || Number.isNaN(sessionId)) {
                return res.status(400).json({ error: "Invalid session id" });
            }

            const session = await prisma.session.findUnique({
                where: { id: sessionId },
                select: {
                    id: true,
                    teacherId: true,
                },
            });

            if (!session) {
                return res.status(404).json({ error: "Session not found" });
            }

            // Only teacher or admin can see all feedback
            const isTeacher = session.teacherId === req.user.id;
            const isAdmin = req.user.role === "admin";

            if (!(isTeacher || isAdmin)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const feedbacks = await prisma.learnerSessionFeedback.findMany({
                where: { sessionId },
                include: {
                    learner: {
                        select: { id: true, name: true, email: true },
                    },
                },
                orderBy: { createdAt: "desc" },
            });

            return res.json({ feedbacks });
        } catch (err) {
            logger.error({ err }, "GET /sessions/:id/all-learner-feedback failed");
            return res.status(500).json({ error: "Failed to load feedback" });
        }
    }
);

// --------------------------------------------------------------------------
// GET /api/sessions/:id/summary - Get complete session summary
// --------------------------------------------------------------------------
router.get("/sessions/:id/summary", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            include: {
                teacher: { select: { id: true, name: true, email: true } },
                user: { select: { id: true, name: true, email: true } },
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        attendedAt: true,
                        user: { select: { id: true, name: true, email: true } },
                    },
                },
                feedback: true,
                learnerFeedbacks: {
                    include: {
                        learner: { select: { id: true, name: true } },
                    },
                },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check permissions
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        // Parse resources used
        let resourcesUsed = [];
        try {
            resourcesUsed = Array.isArray(session.resourcesUsed)
                ? session.resourcesUsed
                : JSON.parse(session.resourcesUsed || "[]");
        } catch {
            resourcesUsed = [];
        }

        // Build attendance summary
        const attendanceSummary = {
            total: session.participants.length,
            attended: session.participants.filter((p) => p.status === "attended")
                .length,
            noShow: session.participants.filter((p) => p.status === "no_show").length,
            excused: session.participants.filter((p) => p.status === "excused")
                .length,
            canceled: session.participants.filter((p) => p.status === "canceled")
                .length,
        };

        // Build feedback summary (only for teacher/admin)
        let feedbackSummary = null;
        if (isTeacher || isAdmin) {
            const ratings = session.learnerFeedbacks.map((f) => f.rating);
            feedbackSummary = {
                count: ratings.length,
                averageRating:
                    ratings.length > 0
                        ? Math.round(
                            (ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10
                        ) / 10
                        : null,
                feedbacks: session.learnerFeedbacks,
            };
        } else {
            // Learners only see their own feedback
            const ownFeedback = session.learnerFeedbacks.find(
                (f) => f.learnerId === viewerId
            );
            feedbackSummary = {
                myFeedback: ownFeedback || null,
            };
        }

        const summary = {
            session: {
                id: session.id,
                title: session.title,
                type: session.type,
                status: session.status,
                startAt: session.startAt,
                endAt: session.endAt,
                teacher: session.teacher,
            },
            attendance: attendanceSummary,
            participants: session.participants.map((p) => ({
                ...p.user,
                status: p.status,
                attendedAt: p.attendedAt,
            })),
            teacherNotes: isTeacher || isAdmin ? session.teacherNotes : null,
            resourcesUsed,
            teacherFeedback: session.feedback
                ? {
                    messageToLearner: session.feedback.messageToLearner,
                    commentsOnSession: session.feedback.commentsOnSession,
                    futureSteps: session.feedback.futureSteps,
                }
                : null,
            learnerFeedback: feedbackSummary,
        };

        return res.json({ summary });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/summary failed");
        return res.status(500).json({ error: "Failed to load summary" });
    }
});

// ==========================================================================
// LOBBY / WAITING ROOM — Group session admission control
// ==========================================================================

// In-memory lobby state: sessionId → Map<learnerId, { id, name, email, joinedAt }>
const lobbyMap = new Map();

function getLobby(sessionId) {
    if (!lobbyMap.has(sessionId)) {
        lobbyMap.set(sessionId, new Map());
    }
    return lobbyMap.get(sessionId);
}

function getLobbyList(sessionId) {
    const lobby = lobbyMap.get(sessionId);
    if (!lobby || lobby.size === 0) return [];
    return Array.from(lobby.values()).sort(
        (a, b) => new Date(a.joinedAt) - new Date(b.joinedAt)
    );
}

function removeLobbyLearner(sessionId, learnerId) {
    const lobby = lobbyMap.get(sessionId);
    if (lobby) {
        lobby.delete(Number(learnerId));
        if (lobby.size === 0) lobbyMap.delete(sessionId);
    }
}

// Cleanup idle lobbies every 10 minutes (sessions older than 4 hours)
const lobbyCleanupInterval = setInterval(() => {
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const [sessionId, lobby] of lobbyMap) {
        let allOld = true;
        for (const entry of lobby.values()) {
            if (new Date(entry.joinedAt).getTime() > cutoff) {
                allOld = false;
                break;
            }
        }
        if (allOld) lobbyMap.delete(sessionId);
    }
}, 10 * 60 * 1000);
lobbyCleanupInterval.unref?.();

// --------------------------------------------------------------------------
// POST /api/sessions/:id/lobby/join - Learner requests admission to group session
// --------------------------------------------------------------------------
router.post("/sessions/:id/lobby/join", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                type: true,
                userId: true,
                teacherId: true,
                classroomState: true,
                participants: {
                    select: { userId: true, status: true },
                },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check if lobby is enabled (enabled by default for all session types)
        const classroomState = getStoredClassroomState(session.classroomState);
        const lobbyEnabled = classroomState?.moderation?.lobbyEnabled !== false;

        if (!lobbyEnabled) {
            // No lobby needed — directly admitted
            return res.json({ ok: true, status: "admitted", lobbyEnabled: false });
        }

        // Check if classroom is locked
        if (classroomState?.moderation?.locked) {
            return res.status(403).json({
                error: "Classroom is locked. Late joins are not allowed.",
                status: "denied",
            });
        }

        const viewerId = Number(req.viewUserId || req.user?.id);
        const isTeacher = session.teacherId === Number(req.user?.id);

        // Teachers skip the lobby
        if (isTeacher) {
            return res.json({ ok: true, status: "admitted", lobbyEnabled: true });
        }

        // Check if learner is an approved participant
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId && p.status !== "canceled"
        );
        const isLegacyLearner = session.userId === viewerId;

        if (!(isParticipant || isLegacyLearner)) {
            return res.status(403).json({ error: "You are not a participant of this session" });
        }

        // Check if already admitted (stored in classroomState.lobby.admitted)
        const admittedList = classroomState?.lobby?.admitted || [];
        if (admittedList.includes(viewerId)) {
            return res.json({ ok: true, status: "admitted" });
        }

        // Add to lobby
        const lobby = getLobby(sessionId);
        const sender = Number.isFinite(viewerId)
            ? await prisma.user.findUnique({
                where: { id: viewerId },
                select: { id: true, name: true, email: true },
            })
            : null;

        lobby.set(viewerId, {
            id: viewerId,
            name: sender?.name || req.body?.name || "Learner",
            email: sender?.email || null,
            joinedAt: new Date().toISOString(),
        });

        return res.json({
            ok: true,
            status: "waiting",
            position: lobby.size,
        });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/lobby/join failed");
        return res.status(500).json({ error: "Failed to join lobby" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/lobby - Teacher gets list of waiting learners
// --------------------------------------------------------------------------
router.get("/sessions/:id/lobby", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                classroomState: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const isTeacher = session.teacherId === Number(req.user?.id);
        const isAdmin = req.user?.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only teachers can view the lobby" });
        }

        return res.json({
            ok: true,
            waiting: getLobbyList(sessionId),
        });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/lobby failed");
        return res.status(500).json({ error: "Failed to get lobby" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/lobby/admit - Teacher admits a learner
// --------------------------------------------------------------------------
router.post("/sessions/:id/lobby/admit", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                classroomState: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const isTeacher = session.teacherId === Number(req.user?.id);
        const isAdmin = req.user?.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only teachers can admit learners" });
        }

        const learnerId = Number(req.body?.learnerId);
        if (!learnerId || !Number.isFinite(learnerId)) {
            return res.status(400).json({ error: "learnerId is required" });
        }

        // Remove from lobby
        removeLobbyLearner(sessionId, learnerId);

        // Persist admission in classroomState
        const existing = getStoredClassroomState(session.classroomState);
        const lobby = existing.lobby || {};
        const admitted = Array.isArray(lobby.admitted) ? [...lobby.admitted] : [];
        if (!admitted.includes(learnerId)) {
            admitted.push(learnerId);
        }

        const nextState = {
            ...existing,
            lobby: { ...lobby, admitted },
            updatedAt: new Date().toISOString(),
        };

        await prisma.session.update({
            where: { id: sessionId },
            data: { classroomState: nextState },
        });

        return res.json({
            ok: true,
            admitted: learnerId,
            waiting: getLobbyList(sessionId),
        });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/lobby/admit failed");
        return res.status(500).json({ error: "Failed to admit learner" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/lobby/deny - Teacher denies a learner
// --------------------------------------------------------------------------
router.post("/sessions/:id/lobby/deny", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const isTeacher = session.teacherId === Number(req.user?.id);
        const isAdmin = req.user?.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only teachers can deny learners" });
        }

        const learnerId = Number(req.body?.learnerId);
        if (!learnerId || !Number.isFinite(learnerId)) {
            return res.status(400).json({ error: "learnerId is required" });
        }

        // Remove from lobby
        removeLobbyLearner(sessionId, learnerId);

        return res.json({
            ok: true,
            denied: learnerId,
            waiting: getLobbyList(sessionId),
        });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/lobby/deny failed");
        return res.status(500).json({ error: "Failed to deny learner" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/lobby/admit-all - Teacher admits all waiting learners
// --------------------------------------------------------------------------
router.post("/sessions/:id/lobby/admit-all", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                classroomState: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const isTeacher = session.teacherId === Number(req.user?.id);
        const isAdmin = req.user?.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only teachers can admit learners" });
        }

        // Get all waiting learner IDs
        const waitingList = getLobbyList(sessionId);
        const learnerIds = waitingList.map((l) => l.id);

        // Clear lobby
        lobbyMap.delete(sessionId);

        // Persist admission in classroomState
        const existing = getStoredClassroomState(session.classroomState);
        const lobby = existing.lobby || {};
        const admitted = Array.isArray(lobby.admitted) ? [...lobby.admitted] : [];
        for (const id of learnerIds) {
            if (!admitted.includes(id)) admitted.push(id);
        }

        const nextState = {
            ...existing,
            lobby: { ...lobby, admitted },
            updatedAt: new Date().toISOString(),
        };

        await prisma.session.update({
            where: { id: sessionId },
            data: { classroomState: nextState },
        });

        return res.json({
            ok: true,
            admittedCount: learnerIds.length,
            admittedIds: learnerIds,
            waiting: [],
        });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/lobby/admit-all failed");
        return res.status(500).json({ error: "Failed to admit all learners" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/lobby/toggle - Teacher enables/disables lobby
// --------------------------------------------------------------------------
router.post("/sessions/:id/lobby/toggle", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                classroomState: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const isTeacher = session.teacherId === Number(req.user?.id);
        const isAdmin = req.user?.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only teachers can toggle the lobby" });
        }

        const enabled = req.body?.enabled !== false;
        const existing = getStoredClassroomState(session.classroomState);
        const moderation = existing.moderation || {};

        const nextState = {
            ...existing,
            moderation: { ...moderation, lobbyEnabled: enabled },
            updatedAt: new Date().toISOString(),
        };

        await prisma.session.update({
            where: { id: sessionId },
            data: { classroomState: nextState },
        });

        return res.json({ ok: true, lobbyEnabled: enabled });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/lobby/toggle failed");
        return res.status(500).json({ error: "Failed to toggle lobby" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/lobby/status - Learner checks their lobby status
// --------------------------------------------------------------------------
router.get("/sessions/:id/lobby/status", requireAuth, async (req, res) => {
    try {
        const sessionId = parseSessionIdParam(req.params.id);
        if (!sessionId) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                type: true,
                teacherId: true,
                classroomState: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const viewerId = Number(req.viewUserId || req.user?.id);
        const isTeacher = session.teacherId === Number(req.user?.id);

        // Teachers are always admitted
        if (isTeacher) {
            return res.json({ ok: true, status: "admitted" });
        }

        const classroomState = getStoredClassroomState(session.classroomState);

        // Check if lobby is even enabled
        if (classroomState?.moderation?.lobbyEnabled === false) {
            return res.json({ ok: true, status: "admitted", lobbyEnabled: false });
        }

        // Check if already admitted
        const admittedList = classroomState?.lobby?.admitted || [];
        if (admittedList.includes(viewerId)) {
            return res.json({ ok: true, status: "admitted" });
        }

        // Check if in lobby
        const lobby = lobbyMap.get(sessionId);
        if (lobby && lobby.has(viewerId)) {
            return res.json({ ok: true, status: "waiting", position: Array.from(lobby.keys()).indexOf(viewerId) + 1 });
        }

        // Not in lobby yet (needs to join)
        return res.json({ ok: true, status: "not_joined" });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/lobby/status failed");
        return res.status(500).json({ error: "Failed to check lobby status" });
    }
});

export default router;
