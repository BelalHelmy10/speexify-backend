import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma, requireAuth, logger } from "./_shared.js";
import { CLASSROOM_UPLOADS_ENABLED, CLASSROOM_CLOUDINARY_MALWARE_SCAN } from "../../config/env.js";
import { classroomCloudinaryConfigured } from "../../services/classroomCloudinaryStorage.js";
import { UPLOADS_DISABLED_MESSAGE } from "../../lib/uploadAvailability.js";
import { scanUploadFile } from "../../lib/uploadSecurity.js";
import { storeMaterial, deleteMaterial, sendMaterial, MAX_CLASSROOM_PDF_BYTES } from "../../services/classroomMaterialStorage.js";

const router = Router();
const MAX_PDF_BYTES = MAX_CLASSROOM_PDF_BYTES;
let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 2;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, callback) => callback(null, req.materialTempDir),
    filename: (_req, _file, callback) => callback(null, "upload.pdf"),
  }),
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 0, parts: 1 },
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
    res.json({ materials: materials.map(materialResponse), maxPdfBytes: MAX_PDF_BYTES });
  } catch (error) {
    logger.error({ err: error }, "GET classroom materials failed");
    res.status(500).json({ error: "Failed to load classroom materials" });
  }
});

router.post("/sessions/:id/materials", requireAuth, async (req, res) => {
  let tempDir;
  let storedFilename;
  let sessionId;
  let acquired = false;
  try {
    const access = await getAccessibleSession(req, res);
    if (!access) return;
    if (!access.isTeacher || !["scheduled", "completed"].includes(access.session.status)) {
      return res.status(403).json({ error: "Only the teacher can upload to an open classroom" });
    }
    if (!CLASSROOM_UPLOADS_ENABLED) {
      return res.status(503).json({ error: UPLOADS_DISABLED_MESSAGE, code: "UPLOADS_DISABLED" });
    }
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      res.set("Retry-After", "5");
      return res.status(429).json({ error: "Uploads are busy. Please try again in a few seconds." });
    }
    activeUploads += 1;
    acquired = true;
    sessionId = access.session.id;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "speexify-pdf-"));
    req.materialTempDir = tempDir;
    await promisify(upload)(req, res);
    const file = req.file;
    if (!file || !/\.pdf$/i.test(file.originalname || "") || file.size < 10) {
      return res.status(400).json({ error: "Choose a valid PDF file" });
    }
    // Inspect only the header/trailer; keep the 25 MB file out of the JS heap.
    const handle = await fs.open(file.path, "r");
    let valid;
    try {
      const header = Buffer.alloc(5);
      const trailer = Buffer.alloc(Math.min(file.size, 1024));
      await handle.read(header, 0, header.length, 0);
      await handle.read(trailer, 0, trailer.length, file.size - trailer.length);
      valid = header.toString("ascii") === "%PDF-" && trailer.includes(Buffer.from("%%EOF"));
    } finally { await handle.close(); }
    if (!valid) return res.status(400).json({ error: "Choose a valid PDF file" });
    if (!(classroomCloudinaryConfigured && CLASSROOM_CLOUDINARY_MALWARE_SCAN)) {
      await scanUploadFile(file.path);
    }
    const id = crypto.randomUUID();
    const title = path.basename(file.originalname.replace(/\\/g, "/"))
      .replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180) || "Uploaded PDF.pdf";
    storedFilename = await storeMaterial(sessionId, `${id}.pdf`, file.path, file.size);
    const material = await prisma.classroomMaterial.create({
      data: { id, sessionId, uploadedBy: Number(req.viewUserId), title,
        filename: storedFilename, size: file.size },
    });
    storedFilename = null; // Database now owns the object.
    return res.status(201).json({ material: materialResponse(material) });
  } catch (error) {
    if (storedFilename) {
      await deleteMaterial(sessionId, storedFilename).catch((cleanupError) =>
        logger.error({ err: cleanupError }, "Classroom PDF rollback failed"));
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? `PDF must be ${MAX_PDF_BYTES / (1024 * 1024)} MB or smaller` : "Invalid PDF upload",
      });
    }
    logger.error({ err: error }, "POST classroom material failed");
    if (!res.destroyed) res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to upload PDF",
    });
  } finally {
    if (acquired) activeUploads -= 1;
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
    return await sendMaterial(req, res, material);
  } catch (error) {
    logger.error({ err: error }, "GET classroom material file failed");
    if (!res.headersSent && !res.destroyed) res.status(500).json({ error: "Failed to load PDF" });
  }
});

export default router;
