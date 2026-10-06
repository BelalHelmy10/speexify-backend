import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CLASSROOM_CLOUDINARY_MALWARE_SCAN } from "../config/env.js";

const cloudName = String(process.env.CLASSROOM_CLOUDINARY_CLOUD_NAME || "").trim();
const apiKey = String(process.env.CLASSROOM_CLOUDINARY_API_KEY || "").trim();
const apiSecret = String(process.env.CLASSROOM_CLOUDINARY_API_SECRET || "").trim();
export const classroomCloudinaryConfigured = Boolean(cloudName && apiKey && apiSecret);
if ([cloudName, apiKey, apiSecret].some(Boolean) && !classroomCloudinaryConfigured) {
  throw new Error("Classroom Cloudinary storage requires cloud name, API key and secret");
}

let client;
async function cloudinaryClient() {
  if (!classroomCloudinaryConfigured) throw new Error("Cloudinary PDF storage is unavailable");
  if (!client) {
    const { v2 } = await import("cloudinary");
    client = v2;
  }
  return client;
}
function options() {
  return { cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret,
    resource_type: "raw", type: "authenticated", secure: true };
}
function publicId(sessionId, filename) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 ||
      !/^[0-9a-f-]{36}\.pdf$/i.test(filename)) throw new Error("Invalid classroom PDF key");
  return `classroom-materials/session-${sessionId}/${filename}`;
}

export async function storeCloudinaryMaterial(sessionId, filename, filePath, size) {
  if (size > 10 * 1024 * 1024) {
    const error = new Error("PDF must be 10 MB or smaller");
    error.statusCode = 413;
    throw error;
  }
  const cloudinary = await cloudinaryClient();
  const id = publicId(sessionId, filename);
  let result;
  try {
    result = await cloudinary.uploader.upload(filePath, {
      ...options(), public_id: id, overwrite: false, timeout: 60_000,
      ...(CLASSROOM_CLOUDINARY_MALWARE_SCAN ? { moderation: "perception_point" } : {}),
    });
  } catch {
    throw new Error("Cloudinary could not accept the PDF upload");
  }
  if (result.public_id !== id || result.resource_type !== "raw" || result.type !== "authenticated") {
    throw new Error("Cloudinary returned unexpected PDF storage metadata");
  }
  if (CLASSROOM_CLOUDINARY_MALWARE_SCAN) {
    try {
      let asset = result;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const status = asset.moderation?.find((item) => item.kind === "perception_point")?.status;
        if (status === "approved") return `cloudinary:${filename}`;
        if (status === "rejected") {
          const error = new Error("This PDF was rejected by the file scanner");
          error.statusCode = 422;
          throw error;
        }
        await delay(3000);
        asset = await cloudinary.api.resource(id, { ...options(), timeout: 5000 });
      }
      const error = new Error("The PDF scan did not finish. Please try uploading again later.");
      error.statusCode = 503;
      throw error;
    } catch (error) {
      await deleteCloudinaryMaterial(sessionId, filename);
      // SDK errors can contain credentials in request options; expose a clean error.
      const scanError = new Error(error.statusCode ? error.message : "The PDF could not be scanned. Please try again later.");
      scanError.statusCode = error.statusCode || 503;
      throw scanError;
    }
  }
  return `cloudinary:${filename}`;
}

export async function deleteCloudinaryMaterial(sessionId, filename) {
  const cloudinary = await cloudinaryClient();
  try {
    await cloudinary.uploader.destroy(publicId(sessionId, filename), { ...options(), timeout: 30_000 });
  } catch { throw new Error("Cloudinary PDF cleanup failed"); }
}

export async function sendCloudinaryMaterial(req, res, material) {
  const filename = material.filename.slice("cloudinary:".length);
  const cloudinary = await cloudinaryClient();
  // The signed upstream URL stays on the server. Every reader must pass the
  // classroom membership check, including subsequent byte-range requests.
  const url = cloudinary.url(publicId(material.sessionId, filename), {
    ...options(), sign_url: true,
  });
  const range = req.headers.range;
  if (range && !/^bytes=\d*-\d*$/.test(range)) return res.status(416).end();
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  res.on("close", abort);
  try {
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      redirect: "error",
    });
    if (![200, 206].includes(response.status)) {
      await response.body?.cancel();
      if (response.status === 416) return res.status(416).end();
      if (response.status === 404) return res.status(404).json({ error: "PDF not found" });
      return res.status(502).json({ error: "PDF storage could not deliver this file" });
    }
    res.status(response.status).set({
      "Content-Type": "application/pdf", "Content-Disposition": "inline",
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
      const value = response.headers.get(name);
      if (value) res.set(name, value);
    }
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    // Never log an upstream signed URL or SDK credential-bearing options.
    res.status(502).json({ error: "PDF storage is temporarily unavailable" });
  } finally { res.off("close", abort); }
}
