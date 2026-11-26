import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { isProd, CLASSROOM_UPLOADS_ENABLED, UPLOADS_ENABLED } from "../config/env.js";
import { uploadRoot } from "../lib/uploadStorage.js";
import { classroomCloudinaryConfigured, storeCloudinaryMaterial,
  deleteCloudinaryMaterial, sendCloudinaryMaterial } from "./classroomCloudinaryStorage.js";

export const MAX_CLASSROOM_PDF_BYTES = (classroomCloudinaryConfigured ? 10 : 25) * 1024 * 1024;

const bucket = String(process.env.CLASSROOM_S3_BUCKET || "").trim();
const region = String(process.env.CLASSROOM_S3_REGION || "").trim();
const endpoint = String(process.env.CLASSROOM_S3_ENDPOINT || "").trim();
const accessKeyId = String(process.env.CLASSROOM_S3_ACCESS_KEY_ID || "").trim();
const secretAccessKey = String(process.env.CLASSROOM_S3_SECRET_ACCESS_KEY || "").trim();
const localRoot = path.join(uploadRoot, "classroom-materials");
if (CLASSROOM_UPLOADS_ENABLED && isProd && !bucket && !classroomCloudinaryConfigured && !UPLOADS_ENABLED) {
  throw new Error("Private object storage is required for production classroom PDF uploads");
}
if (bucket && (!region || Boolean(accessKeyId) !== Boolean(secretAccessKey))) {
  throw new Error("Classroom storage requires a region and a complete credential pair (or an IAM role)");
}

let sdk;
let client;
async function storageClient() {
  if (!sdk) sdk = await import("@aws-sdk/client-s3");
  if (!client) client = new sdk.S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    requestChecksumCalculation: "WHEN_REQUIRED",
    maxAttempts: 2,
  });
  return client;
}

function objectKey(sessionId, filename) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 ||
      !/^[0-9a-f-]{36}\.pdf$/i.test(filename)) {
    throw new Error("Invalid classroom material storage key");
  }
  return `classroom-materials/session-${sessionId}/${filename}`;
}

export async function storeMaterial(sessionId, filename, filePath, size) {
  const key = objectKey(sessionId, filename);
  if (classroomCloudinaryConfigured) return storeCloudinaryMaterial(sessionId, filename, filePath, size);
  if (bucket) {
    const s3 = await storageClient();
    const body = createReadStream(filePath);
    try {
      await s3.send(new sdk.PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentLength: size,
        ContentType: "application/pdf", CacheControl: "private, no-store",
        Metadata: { "session-id": String(sessionId) },
      }), { abortSignal: AbortSignal.timeout(60_000) });
    } finally { body.destroy(); }
    // Store the mode in the existing filename column; no schema migration.
    return `s3:${filename}`;
  }
  await fs.mkdir(localRoot, { recursive: true, mode: 0o700 });
  await fs.copyFile(filePath, path.join(localRoot, filename), fs.constants.COPYFILE_EXCL);
  await fs.chmod(path.join(localRoot, filename), 0o600);
  return filename;
}

export async function deleteMaterial(sessionId, storedFilename) {
  if (storedFilename.startsWith("cloudinary:")) {
    return deleteCloudinaryMaterial(sessionId, storedFilename.slice("cloudinary:".length));
  }
  const remote = storedFilename.startsWith("s3:");
  const filename = remote ? storedFilename.slice(3) : storedFilename;
  const key = objectKey(sessionId, filename);
  if (remote) {
    const s3 = await storageClient();
    await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(30_000) });
  } else await fs.rm(path.join(localRoot, filename), { force: true });
}

// A stored material never changes for a given id, so a stable validator lets
// the browser keep its copy: every reopen/late join revalidates (the
// membership check still runs) and gets a 304 instead of re-downloading the
// PDF over the learner's connection, which competed with the video call.
export const MATERIAL_CACHE_CONTROL = "private, no-cache";

export function materialEtag(material) {
  return `"m-${material.id}-${material.size ?? 0}"`;
}

function matchesEtag(req, etag) {
  const header = req.headers["if-none-match"];
  if (!header) return false;
  return String(header).split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

export async function sendMaterial(req, res, material) {
  const etag = materialEtag(material);
  if (matchesEtag(req, etag)) {
    res.set({ ETag: etag, "Cache-Control": MATERIAL_CACHE_CONTROL });
    return res.status(304).end();
  }
  if (material.filename.startsWith("cloudinary:")) return sendCloudinaryMaterial(req, res, material);
  const remote = material.filename.startsWith("s3:");
  const filename = remote ? material.filename.slice(3) : material.filename;
  const key = objectKey(material.sessionId, filename);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": "inline",
    "Cache-Control": MATERIAL_CACHE_CONTROL, ETag: etag, "X-Content-Type-Options": "nosniff" });
  if (!remote) {
    return res.sendFile(path.join(localRoot, filename), { etag: false, lastModified: false, cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).json({ error: "PDF not found" });
    });
  }
  if (!bucket) return res.status(503).json({ error: "PDF storage is unavailable" });
  const range = req.headers.range;
  if (range && !/^bytes=\d*-\d*$/.test(range)) return res.status(416).end();
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  res.on("close", abort);
  try {
    const s3 = await storageClient();
    const object = await s3.send(new sdk.GetObjectCommand({
      Bucket: bucket, Key: key, ...(range ? { Range: range } : {}),
    }), { abortSignal: controller.signal });
    res.set("Accept-Ranges", "bytes");
    if (object.ContentLength != null) res.set("Content-Length", String(object.ContentLength));
    if (object.ContentRange) { res.status(206); res.set("Content-Range", object.ContentRange); }
    await pipeline(object.Body, res);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.removeHeader("Content-Length");
    const status = error.$metadata?.httpStatusCode;
    if (status === 416) return res.status(416).end();
    if (status === 404) return res.status(404).json({ error: "PDF not found" });
    throw error;
  } finally { res.off("close", abort); }
}
