import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const AVATAR_UPLOAD_DIR = path.join(process.cwd(), "uploads", "avatars");
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;

const MIME_TO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAGIC_SIGNATURES = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/jpg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
};

fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });

function hasValidSignature(buffer, mimetype) {
  const signatures = MAGIC_SIGNATURES[mimetype];
  if (!signatures) return false;
  return signatures.some((signature) =>
    signature.every((byte, index) => buffer[index] === byte)
  );
}

function avatarUrlForFilename(filename) {
  return `/api/me/avatar/${filename}`;
}

export function avatarFilenameFromUrl(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== "string") return "";
  const marker = "/api/me/avatar/";
  if (!avatarUrl.startsWith(marker)) return "";
  return path.basename(avatarUrl.slice(marker.length));
}

export function resolveAvatarPath(filename) {
  const safeName = path.basename(String(filename || ""));
  if (!safeName || safeName !== filename) return null;

  const resolved = path.resolve(AVATAR_UPLOAD_DIR, safeName);
  const uploadRoot = path.resolve(AVATAR_UPLOAD_DIR);
  if (!resolved.startsWith(`${uploadRoot}${path.sep}`)) return null;
  return resolved;
}

export function deleteAvatarFile(avatarUrl) {
  const filename = avatarFilenameFromUrl(avatarUrl);
  if (!filename) return;

  const filePath = resolveAvatarPath(filename);
  if (!filePath || !fs.existsSync(filePath)) return;
  fs.unlinkSync(filePath);
}

export function saveAvatarFile(userId, file) {
  if (!file) {
    const error = new Error("No file uploaded");
    error.statusCode = 400;
    throw error;
  }

  if (!MIME_TO_EXTENSION[file.mimetype]) {
    const error = new Error("Only JPG, PNG, WEBP, or GIF images are allowed");
    error.statusCode = 400;
    throw error;
  }

  if (!hasValidSignature(file.buffer, file.mimetype)) {
    const error = new Error("Invalid image file");
    error.statusCode = 400;
    throw error;
  }

  const extension = MIME_TO_EXTENSION[file.mimetype];
  const token = crypto.randomBytes(10).toString("hex");
  const filename = `user-${userId}-${Date.now()}-${token}.${extension}`;
  const filePath = path.join(AVATAR_UPLOAD_DIR, filename);

  fs.writeFileSync(filePath, file.buffer);
  return avatarUrlForFilename(filename);
}

export const profileAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AVATAR_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!MIME_TO_EXTENSION[file.mimetype]) {
      return cb(new Error("Only JPG, PNG, WEBP, or GIF images are allowed"));
    }
    cb(null, true);
  },
});
