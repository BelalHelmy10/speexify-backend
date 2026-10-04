import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma, requireAuth, logger } from "./_shared.js";
import { requireUploadsEnabled } from "../../lib/uploadAvailability.js";
import { uploadRoot } from "../../lib/uploadStorage.js";
import { scanUploadBuffer } from "../../lib/uploadSecurity.js";

const router = Router();
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const materialRoot = path.join(uploadRoot, "classroom-materials");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
}).single("file");

function parseSessionId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getAccessibleSession(req, res) {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) {
    res.status(400).json({ error: "Invalid session id" });
    return null;
  }
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      teacherId: true,
      userId: true,
      participants: { select: { userId: true, status: true } },
    },
  });
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  const viewerId = Number(req.viewUserId);
  const isTeacher = session.teacherId === viewerId;
  const isLearner = session.userId === viewerId || session.participants.some(
    (participant) => participant.userId === viewerId && participant.status !== "canceled"
  );
  if (!isTeacher && !isLearner && req.user?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { session, isTeacher };
}

function materialResponse(material) {
  return {
    id: material.id,
    _id: `upload-${material.id}`,
    title: material.title,
    fileName: material.title,
    sourceType: "pdf",
    classroomUpload: true,
    fileUrl: `/api/sessions/${material.sessionId}/materials/${material.id}/file`,
    size: material.size,
    createdAt: material.createdAt,
  };
}

router.get("/sessions/:id/materials", requireAuth, async (req, res) => {
  try {
    const access = await getAccessibleSession(req, res);
    if (!access) return;
    const materials = await prisma.classroomMaterial.findMany({
      where: { sessionId: access.session.id },
      orderBy: { createdAt: "asc" },
    });
    res.json({ materials: materials.map(materialResponse) });
  } catch (error) {
    logger.error({ err: error }, "GET classroom materials failed");
    res.status(500).json({ error: "Failed to load classroom materials" });
  }
});

router.post("/sessions/:id/materials", requireAuth, requireUploadsEnabled, async (req, res) => {
  try {
    const access = await getAccessibleSession(req, res);
    if (!access) return;
    if (!access.isTeacher || access.session.status !== "scheduled") {
      return res.status(403).json({ error: "Only the teacher can upload to an open classroom" });
    }

    upload(req, res, async (uploadError) => {
      if (uploadError) {
        const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
        return res.status(tooLarge ? 413 : 400).json({
          error: tooLarge ? "PDF must be 25 MB or smaller" : "Invalid PDF upload",
        });
      }
      const file = req.file;
      const isPdf = file?.buffer?.subarray(0, 5).toString("ascii") === "%PDF-" &&
        file.buffer.subarray(-1024).includes(Buffer.from("%%EOF"));
      if (!file || !isPdf || !/\.pdf$/i.test(file.originalname || "")) {
        return res.status(400).json({ error: "Choose a valid PDF file" });
      }

      let filePath;
      try {
        await fs.mkdir(materialRoot, { recursive: true, mode: 0o700 });
        await scanUploadBuffer(file.buffer, ".pdf");
        const id = crypto.randomUUID();
        const filename = `${id}.pdf`;
        const title = path.basename(file.originalname.replace(/\\/g, "/"))
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 180) || "Uploaded PDF.pdf";
        filePath = path.join(materialRoot, filename);
        await fs.writeFile(filePath, file.buffer, { flag: "wx", mode: 0o600 });
        const material = await prisma.classroomMaterial.create({
          data: {
            id,
            sessionId: access.session.id,
            uploadedBy: Number(req.viewUserId),
            title,
            filename,
            size: file.size,
          },
        });
        return res.status(201).json({ material: materialResponse(material) });
      } catch (error) {
        if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
        logger.error({ err: error }, "POST classroom material failed");
        return res.status(error.statusCode || 500).json({
          error: error.statusCode ? error.message : "Failed to upload PDF",
        });
      }
    });
  } catch (error) {
    logger.error({ err: error }, "POST classroom material authorization failed");
    res.status(500).json({ error: "Failed to upload PDF" });
  }
});

router.get("/sessions/:id/materials/:materialId/file", requireAuth, async (req, res) => {
  try {
    const access = await getAccessibleSession(req, res);
    if (!access) return;
    const material = await prisma.classroomMaterial.findFirst({
      where: { id: req.params.materialId, sessionId: access.session.id },
    });
    if (!material) return res.status(404).json({ error: "PDF not found" });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return res.sendFile(path.join(materialRoot, material.filename), (error) => {
      if (error && !res.headersSent) {
        res.status(error.statusCode || 404).json({ error: "PDF not found" });
      }
    });
  } catch (error) {
    logger.error({ err: error }, "GET classroom material file failed");
    res.status(500).json({ error: "Failed to load PDF" });
  }
});

export default router;
