// src/services/emailService.js
import axios from "axios";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM =
  process.env.EMAIL_FROM || "Speexify <no-reply@mail.speexify.com>";
const DELIVERY_RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

function parseFromHeader(from) {
  let name = "Speexify";
  let email = String(from || "").trim();

  const match = email.match(/^(.*)<(.+@.+)>$/);
  if (match) {
    name = match[1].trim().replace(/^"|"$/g, "") || "Speexify";
    email = match[2].trim();
  }

  return { name, email };
}

function normalizeRecipients(to) {
  // supports: string, array of strings, {email, name}, array of {email, name}
  if (!to) return [];

  const arr = Array.isArray(to) ? to : String(to).split(",");

  return arr
    .map((item) => {
      if (!item) return null;

      if (typeof item === "string") {
        return { email: item.trim() };
      }

      if (typeof item === "object" && item.email) {
        return { email: String(item.email).trim(), name: item.name?.trim() };
      }

      return null;
    })
    .filter(Boolean);
}

function retryDelayMs(attempts) {
  return DELIVERY_RETRY_DELAYS_MS[
    Math.min(Math.max(Number(attempts) - 1, 0), DELIVERY_RETRY_DELAYS_MS.length - 1)
  ];
}

async function sendViaResend(toList, subject, html) {
  const { name, email } = parseFromHeader(EMAIL_FROM);
  const payload = {
    from: name ? `${name} <${email}>` : email,
    to: toList.map((r) => r.email),
    subject: String(subject || ""),
    html: String(html || ""),
  };

  await axios.post("https://api.resend.com/emails", payload, {
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

async function markDeliveryFailed(deliveryId, error, attempts) {
  await prisma.notificationDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "FAILED",
      attempts,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
      lastAttemptAt: new Date(),
      lastError: String(error?.message || error || "Email delivery failed").slice(0, 1000),
      lockedAt: null,
      lockedBy: null,
    },
  });
}

/**
 * sendEmail(to, subject, html)
 * - Uses Resend API
 * - If RESEND_API_KEY missing -> logs and returns (safe dev mode)
 */
export async function sendEmail(to, subject, html, options = {}) {
  const toList = normalizeRecipients(to);

  if (!toList.length) {
    logger.warn({ to, subject }, "sendEmail called with no valid recipients");
    return;
  }

  const delivery = options.track
    ? await prisma.notificationDelivery.create({
        data: {
          userId: options.userId || null,
          notificationId: options.notificationId || null,
          eventType: String(options.eventType || "email"),
          recipient: toList.map((recipient) => recipient.email).join(","),
          subject: String(subject || ""),
          bodyHtml: String(html || ""),
          status: "PROCESSING",
          attempts: 1,
          lastAttemptAt: new Date(),
        },
      })
    : null;

  if (!RESEND_API_KEY) {
    logger.info(
      { to: toList, subject },
      "[DEV EMAIL] Email NOT SENT — RESEND_API_KEY is missing."
    );
    if (delivery) {
      await markDeliveryFailed(
        delivery.id,
        new Error("RESEND_API_KEY is not configured"),
        delivery.attempts
      );
    }
    return { sent: false, deliveryId: delivery?.id || null };
  }

  try {
    await sendViaResend(toList, subject, html);

    if (delivery) {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });
    }

    logger.info({ to: toList, subject }, "📧 Email sent via Resend");
    return { sent: true, deliveryId: delivery?.id || null };
  } catch (err) {
    if (delivery) {
      await markDeliveryFailed(delivery.id, err, delivery.attempts);
    }
    logger.error(
      {
        to: toList,
        subject,
        message: err.message,
        status: err.response?.status,
        responseData: err.response?.data,
      },
      "❌ Failed to send email via Resend"
    );
    throw err;
  }
}

/**
 * Retry durable email deliveries. The claim update makes the worker safe to
 * run on more than one instance without sending the same row concurrently.
 */
export async function processNotificationDeliveryBatch({
  limit = 25,
  workerId = `email-${process.pid}`,
} = {}) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);

  // A process can die after claiming a row but before the provider call. Move
  // abandoned claims back into the retry queue so PROCESSING is never a
  // permanent terminal state.
  await prisma.notificationDelivery.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: { lt: staleBefore },
    },
    data: {
      status: "FAILED",
      nextAttemptAt: now,
      lastError: "Recovered stale notification delivery claim",
      lockedAt: null,
      lockedBy: null,
    },
  });

  const candidates = await prisma.notificationDelivery.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { lte: now },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: Math.min(Math.max(Number(limit) || 25, 1), 100),
  });

  let succeeded = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const claimed = await prisma.notificationDelivery.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: now,
        lockedBy: workerId,
        lastAttemptAt: now,
      },
    });
    if (claimed.count !== 1) continue;

    const attempt = Number(candidate.attempts || 0) + 1;
    try {
      if (!RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not configured");
      }
      await sendViaResend(
        normalizeRecipients(candidate.recipient),
        candidate.subject,
        candidate.bodyHtml
      );
      await prisma.notificationDelivery.update({
        where: { id: candidate.id },
        data: {
          status: "SENT",
          attempts: attempt,
          sentAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      succeeded += 1;
    } catch (error) {
      await markDeliveryFailed(candidate.id, error, attempt);
      failed += 1;
      logger.error(
        { err: error, deliveryId: candidate.id, attempts: attempt },
        "notification delivery retry failed"
      );
    }
  }

  return { inspected: candidates.length, succeeded, failed };
}
