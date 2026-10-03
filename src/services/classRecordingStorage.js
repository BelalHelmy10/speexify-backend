import { S3Client, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = String(process.env.RECORDINGS_S3_BUCKET || "").trim();
const region = String(process.env.RECORDINGS_S3_REGION || "").trim();
const endpoint = String(process.env.RECORDINGS_S3_ENDPOINT || "").trim();
const accessKeyId = String(process.env.RECORDINGS_S3_ACCESS_KEY_ID || "").trim();
const secretAccessKey = String(process.env.RECORDINGS_S3_SECRET_ACCESS_KEY || "").trim();

const hasBothStaticCredentials = Boolean(accessKeyId && secretAccessKey);
const hasNoStaticCredentials = !accessKeyId && !secretAccessKey;
const configured = Boolean(
  bucket && region && (hasBothStaticCredentials || hasNoStaticCredentials)
);
const client = configured
  ? new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    })
  : null;

export function recordingsStorageReady() {
  return configured;
}

export function validRecordingKey(sessionId, key) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return false;
  if (typeof key !== "string" || key.length > 255) return false;
  const prefix = `class-recordings/session-${sessionId}/speexify-classroom-${sessionId}_`;
  if (!key.startsWith(prefix)) return false;
  return /^[A-Za-z0-9._-]+\.mp4$/.test(key.slice(prefix.length));
}

export async function inspectRecordingObject(sessionId, key) {
  if (!client || !validRecordingKey(sessionId, key)) {
    throw new Error("Recording storage or object key is invalid");
  }
  const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const sizeBytes = Number(object.ContentLength);
  const metadataSessionId = String(object.Metadata?.["session-id"] || "");
  const contentType = String(object.ContentType || "").toLowerCase();
  if (
    metadataSessionId !== String(sessionId) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    contentType !== "video/mp4"
  ) {
    throw new Error("Recording object metadata does not match the class");
  }
  return { sizeBytes: BigInt(sizeBytes), contentType };
}

export async function signedRecordingUrl(key) {
  if (!client) throw new Error("Recording storage is not configured");
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 4 * 60 * 60 }
  );
}
