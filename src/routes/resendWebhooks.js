import crypto from "node:crypto";
import { Router } from "express";
import { recordResendWebhookEvent } from "../services/emailService.js";
import { logger } from "../lib/logger.js";

const router = Router();
const WEBHOOK_SECRET = String(process.env.RESEND_WEBHOOK_SECRET || "").trim();

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function verifyResendWebhookSignature({
  rawBody,
  svixId,
  svixTimestamp,
  svixSignature,
  secret = WEBHOOK_SECRET,
  nowMs = Date.now(),
} = {}) {
  if (!secret || !rawBody || !svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  const timestampMs = Number(svixTimestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > 5 * 60 * 1000) {
    return false;
  }

  const encodedSecret = String(secret).replace(/^whsec_/, "");
  let secretBytes;
  try {
    secretBytes = Buffer.from(encodedSecret, "base64");
  } catch {
    return false;
  }
  if (!secretBytes.length) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${Buffer.from(rawBody).toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  return String(svixSignature)
    .split(" ")
    .some((candidate) => {
      const [version, signature] = candidate.split(",", 2);
      return version === "v1" && timingSafeStringEqual(signature, expected);
    });
}

router.post("/resend", async (req, res) => {
  const rawBody = req.rawBody;
  const isProduction = process.env.NODE_ENV === "production";
  const signatureValid = verifyResendWebhookSignature({
    rawBody,
    svixId: req.get("svix-id"),
    svixTimestamp: req.get("svix-timestamp"),
    svixSignature: req.get("svix-signature"),
  });

  if (!WEBHOOK_SECRET && isProduction) {
    logger.error("RESEND_WEBHOOK_SECRET is not configured");
    return res.status(503).json({ error: "Webhook verification is unavailable" });
  }

  if (!signatureValid && (isProduction || WEBHOOK_SECRET)) {
    logger.warn({ hasSecret: !!WEBHOOK_SECRET }, "Rejected invalid Resend webhook signature");
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  try {
    const event = req.body && typeof req.body === "object"
      ? req.body
      : JSON.parse(Buffer.from(rawBody || "").toString("utf8"));
    const result = await recordResendWebhookEvent(event);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    logger.error({ err: error }, "Resend webhook processing failed");
    return res.status(500).json({ received: false, error: "Webhook processing failed" });
  }
});

export default router;
