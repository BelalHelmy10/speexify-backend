// src/lib/supportUpload.js
// IMPROVED: Better security, file validation, cloud storage ready

import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const uploadDir = path.join(process.cwd(), "uploads", "support");

// Ensure directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Allowed MIME types
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

// Max file size: 5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

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
  // Check file signatures (magic numbers)
  const signatures = {
    "image/jpeg": [[0xff, 0xd8, 0xff]],
    "image/png": [[0x89, 0x50, 0x4e, 0x47]],
    "image/gif": [[0x47, 0x49, 0x46, 0x38]],
    "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  };

  const signature = signatures[mimetype];
  if (!signature) return false;

  // Check if buffer starts with any of the valid signatures
  return signature.some((sig) => {
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
  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid file type. Only images are allowed."), false);
  }

  // Sanitize original filename
  const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  file.originalname = sanitized;

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
    console.error("File validation error:", err);

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
    console.error("Failed to delete file:", err);
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

    console.log(`Cleaned up ${deletedCount} old support files`);
    return deletedCount;
  } catch (err) {
    console.error("Cleanup failed:", err);
    return 0;
  }
}
