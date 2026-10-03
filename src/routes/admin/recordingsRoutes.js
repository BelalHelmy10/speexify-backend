import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { recordingsStorageReady, signedRecordingUrl } from "../../services/classRecordingStorage.js";

const router = Router();

function boundedQueryInt(value, fallback, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, max)
    : fallback;
}

router.get("/admin/recordings", requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.max(boundedQueryInt(req.query.limit, 20, 100), 1);
  const offset = boundedQueryInt(req.query.offset, 0, 100000);
  const sessionId = req.query.sessionId ? Number(req.query.sessionId) : null;
  if (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) {
    return res.status(400).json({ error: "Invalid class ID" });
  }
  try {
    const where = sessionId ? { sessionId } : {};
    const [records, total] = await Promise.all([
      prisma.classRecording.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          sessionId: true,
          sessionTitle: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
          session: {
            select: {
              startAt: true,
              teacher: { select: { name: true } },
            },
          },
        },
      }),
      prisma.classRecording.count({ where }),
    ]);
    res.set("Cache-Control", "no-store");
    return res.json({
      items: records.map((record) => ({
        ...record,
        sizeBytes: record.sizeBytes.toString(),
      })),
      total,
      storageReady: recordingsStorageReady(),
    });
  } catch (err) {
    logger.error({ err }, "Admin recordings list failed");
    return res.status(500).json({ error: "Could not load recordings" });
  }
});

router.get("/admin/recordings/:id/play", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid recording ID" });
  }
  if (!recordingsStorageReady()) {
    return res.status(503).json({ error: "Recording storage is not configured" });
  }
  try {
    const recording = await prisma.classRecording.findUnique({
      where: { id },
      select: { objectKey: true },
    });
    if (!recording) return res.status(404).json({ error: "Recording not found" });
    const url = await signedRecordingUrl(recording.objectKey);
    res.set("Cache-Control", "no-store");
    return res.json({ url, expiresIn: 4 * 60 * 60 });
  } catch (err) {
    logger.error({ err, recordingId: id }, "Admin recording playback failed");
    return res.status(502).json({ error: "Could not open recording" });
  }
});

export default router;
