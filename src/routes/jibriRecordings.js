import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  inspectRecordingObject,
  recordingsStorageReady,
  validRecordingKey,
} from "../services/classRecordingStorage.js";

const router = Router();

function validToken(authorization) {
  const expected = String(process.env.JIBRI_INGEST_TOKEN || "");
  if (expected.length < 32) return false;
  const match = /^Bearer (\S+)$/i.exec(String(authorization || ""));
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const actual = Buffer.from(expected);
  return provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
}

// Mounted before browser session/CSRF middleware; only the Jibri worker knows this token.
router.post("/recordings", async (req, res) => {
  if (!validToken(req.get("authorization"))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!recordingsStorageReady()) {
    return res.status(503).json({ error: "Recording storage is not configured" });
  }
  const sessionId = Number(req.body?.sessionId);
  const key = req.body?.key;
  if (!validRecordingKey(sessionId, key)) {
    return res.status(400).json({ error: "Invalid class recording key" });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, title: true },
    });
    if (!session) return res.status(404).json({ error: "Class not found" });

    const object = await inspectRecordingObject(sessionId, key);
    const recording = await prisma.classRecording.upsert({
      where: { objectKey: key },
      create: {
        sessionId,
        sessionTitle: session.title,
        objectKey: key,
        contentType: object.contentType,
        sizeBytes: object.sizeBytes,
      },
      update: {},
      select: { id: true },
    });
    return res.status(201).json({ id: recording.id });
  } catch (err) {
    logger.error({ err, sessionId }, "Jibri recording registration failed");
    return res.status(502).json({ error: "Could not verify or register recording" });
  }
});

export default router;
