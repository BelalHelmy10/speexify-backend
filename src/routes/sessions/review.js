import { Router, prisma, requireAuth, logger } from "./_shared.js";
import {
  isSessionReviewAvailable,
  normalizeReviewResources,
} from "../../services/sessionReviewService.js";

const router = Router();

function parseSessionId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getLearnerAccess(req, session) {
  const viewerId = Number(req.viewUserId || req.user?.id);
  const isParticipant = (session.participants || []).some(
    (participant) => participant.userId === viewerId && participant.status !== "canceled"
  );
  return {
    viewerId,
    isLearner: session.userId === viewerId || isParticipant,
    isTeacher: session.teacherId === viewerId,
  };
}

async function findReviewSession(sessionId) {
  return prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      title: true,
      startAt: true,
      endAt: true,
      completedAt: true,
      status: true,
      userId: true,
      teacherId: true,
      resourcesUsed: true,
      resourcesUsedAt: true,
      teacher: { select: { id: true, name: true, email: true } },
      participants: { select: { userId: true, status: true } },
      classroomMaterials: {
        select: { id: true, title: true, size: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

function authorizeReview(req, res, session) {
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }

  const access = getLearnerAccess(req, session);
  if (!access.isLearner || access.isTeacher) {
    res.status(403).json({ error: "Session review is available to learners only" });
    return null;
  }

  if (!isSessionReviewAvailable(session)) {
    res.status(409).json({
      error: "Session review will be available after the session ends",
      code: "REVIEW_NOT_READY",
    });
    return null;
  }

  return access;
}

router.get("/sessions/:id/review", requireAuth, async (req, res) => {
  try {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return res.status(400).json({ error: "Invalid session id" });

    const session = await findReviewSession(sessionId);
    const access = authorizeReview(req, res, session);
    if (!access) return;

    const resources = normalizeReviewResources(
      session.resourcesUsed,
      session.resourcesUsedAt
    );
    const usedIds = new Set(resources.map((resource) => resource.id));
    const materials = session.classroomMaterials
      .map((material) => ({
        id: material.id,
        _id: `upload-${material.id}`,
        title: material.title,
        fileName: material.title,
        sourceType: "pdf",
        classroomUpload: true,
        fileUrl: `/api/sessions/${session.id}/materials/${material.id}/file`,
        size: material.size,
        createdAt: material.createdAt,
      }))
      .filter((material) => usedIds.has(material._id));

    return res.json({
      review: {
        id: session.id,
        title: session.title,
        startAt: session.startAt,
        endAt: session.endAt,
        completedAt: session.completedAt,
        teacher: session.teacher,
        resources,
        materials,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "GET /sessions/:id/review failed");
    return res.status(500).json({ error: "Failed to load session review" });
  }
});

router.get("/sessions/:id/review/annotations", requireAuth, async (req, res) => {
  try {
    const sessionId = parseSessionId(req.params.id);
    const resourceId = typeof req.query.resourceId === "string"
      ? req.query.resourceId.trim().slice(0, 300)
      : "";
    if (!sessionId || !resourceId) {
      return res.status(400).json({ error: "Valid sessionId and resourceId are required" });
    }

    const session = await findReviewSession(sessionId);
    const access = authorizeReview(req, res, session);
    if (!access) return;

    const resources = normalizeReviewResources(
      session.resourcesUsed,
      session.resourcesUsedAt
    );
    if (!resources.some((resource) => resource.id === resourceId)) {
      return res.status(404).json({ error: "Reviewed material not found" });
    }

    const ownerIds = [access.viewerId];
    if (session.teacherId && !ownerIds.includes(session.teacherId)) {
      ownerIds.push(session.teacherId);
    }
    const annotations = await prisma.classroomAnnotation.findMany({
      where: { sessionId, resourceId, userId: { in: ownerIds } },
      orderBy: { updatedAt: "desc" },
      select: {
        userId: true,
        resourceId: true,
        payload: true,
        version: true,
        updatedAt: true,
      },
    });

    return res.json({ ok: true, annotations });
  } catch (error) {
    logger.error({ err: error }, "GET /sessions/:id/review/annotations failed");
    return res.status(500).json({ error: "Failed to load review annotations" });
  }
});

export default router;
