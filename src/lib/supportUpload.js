import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { logger } from "./logger.js";

const uploadDir = path.join(process.cwd(), "uploads", "support");

// Ensure directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_FILE_TYPES = {
  "image/jpeg": {
    extensions: [".jpg", ".jpeg"],
    signatures: [[0xff, 0xd8, 0xff]],
  },
  "image/jpg": {
    extensions: [".jpg", ".jpeg"],
    signatures: [[0xff, 0xd8, 0xff]],
  },
  "image/png": {
    extensions: [".png"],
    signatures: [[0x89, 0x50, 0x4e, 0x47]],
  },
  "image/gif": {
    extensions: [".gif"],
    signatures: [[0x47, 0x49, 0x46, 0x38]],
  },
  "image/webp": {
    extensions: [".webp"],
    signatures: [[0x52, 0x49, 0x46, 0x46]],
  },
  "application/pdf": {
    extensions: [".pdf"],
    signatures: [[0x25, 0x50, 0x44, 0x46]],
  },
  "application/msword": {
    extensions: [".doc"],
    signatures: [[0xd0, 0xcf, 0x11, 0xe0]],
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    signatures: [[0x50, 0x4b, 0x03, 0x04]],
  },
};

const ALLOWED_MIME_TYPES = Object.keys(ALLOWED_FILE_TYPES);
const MAX_FILE_SIZE = 12 * 1024 * 1024;

/**
 * Generate secure filename
 */
function generateSecureFilename(originalname) {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString("hex");
  const ext = path.extname(originalname).toLowerCase();

  // Sanitize extension
  const safeExt = ext.replace(/[^a-z0-9.]/gi, "");

  return `${timestamp}-${randomString}${safeExt}`;
}

/**
 * Validate file content (basic magic number check)
 */
function validateFileContent(buffer, mimetype) {
  const fileType = ALLOWED_FILE_TYPES[mimetype];
  if (!fileType) return false;

  return fileType.signatures.some((sig) => {
    return sig.every((byte, index) => buffer[index] === byte);
  });
}

/**
 * Multer storage configuration
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, generateSecureFilename(file.originalname));
  },
});

/**
 * File filter with strict validation
 */
const fileFilter = (req, file, cb) => {
  const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  file.originalname = sanitized;

  const ext = path.extname(file.originalname).toLowerCase();
  const fileType = ALLOWED_FILE_TYPES[file.mimetype];

  if (!fileType || !fileType.extensions.includes(ext)) {
    return cb(
      new Error("Invalid file type. Upload images, PDF, DOC, or DOCX files."),
      false
    );
  }

  cb(null, true);
};

/**
 * Export multer instance
 */
export const supportUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1, // Only allow one file at a time
  },
});

/**
 * Middleware to validate file content after upload
 * Use this AFTER multer middleware
 */
export function validateUploadedFile(req, res, next) {
  if (!req.file) {
    return next();
  }

  try {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);

    // Validate file content
    if (!validateFileContent(buffer, req.file.mimetype)) {
      // Delete invalid file
      fs.unlinkSync(filePath);
      return res.status(400).json({
        error: "Invalid file content. File does not match its declared type.",
      });
    }

    next();
  } catch (err) {
    logger.error({ err }, "Support file validation failed");

    // Clean up if file exists
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.status(500).json({ error: "File validation failed" });
  }
}

/**
 * Cloud storage adapter (implement when moving to S3/CloudFlare R2)
 */
export class CloudStorageAdapter {
  constructor(config) {
    this.config = config;
    // Initialize cloud storage client (S3, R2, GCS, etc.)
  }

  async upload(file, bucket, key) {
    // Implement cloud upload
    throw new Error("Cloud storage not implemented yet");
  }

  async delete(bucket, key) {
    // Implement cloud delete
    throw new Error("Cloud storage not implemented yet");
  }

  getPublicUrl(bucket, key) {
    // Return public URL
    throw new Error("Cloud storage not implemented yet");
  }
}

/**
 * Delete file helper
 */
export function deleteFile(filename) {
  const filePath = path.join(uploadDir, filename);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err, filename }, "Failed to delete support upload");
    return false;
  }
}

/**
 * Cleanup old files (run periodically)
 */
export function cleanupOldFiles(daysOld = 30) {
  const cutoffDate = Date.now() - daysOld * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(uploadDir);

    let deletedCount = 0;

    files.forEach((file) => {
      const filePath = path.join(uploadDir, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < cutoffDate) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    });

    logger.info({ deletedCount }, "Cleaned up old support uploads");
    return deletedCount;
  } catch (err) {
    logger.warn({ err }, "Support upload cleanup failed");
    return 0;
  }
}
