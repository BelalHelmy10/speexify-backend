// src/services/emailService.js
import axios from "axios";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { normalizeEmailLocale, withEmailDirection } from "./emailTemplates.js";
import { recordBusinessMetric } from "../observability/metrics.js";
import { notifyOperationalAlert } from "../observability/alerts.js";

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
        return { email: item.trim().toLowerCase() };
      }

      if (typeof item === "object" && item.email) {
        return { email: String(item.email).trim().toLowerCase(), name: item.name?.trim() };
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

  const response = await axios.post("https://api.resend.com/emails", payload, {
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
  return { providerMessageId: response?.data?.id || null };
}

async function filterSuppressedRecipients(toList) {
  if (!prisma.emailSuppression || !toList.length) {
    return { allowed: toList, suppressed: [] };
  }

  const emails = [...new Set(toList.map((recipient) => recipient.email))];
  const rows = await prisma.emailSuppression.findMany({
    where: { email: { in: emails } },
    select: { email: true, reason: true },
  });
  const suppressedByEmail = new Map(rows.map((row) => [row.email, row.reason]));
  return {
    allowed: toList.filter((recipient) => !suppressedByEmail.has(recipient.email)),
    suppressed: toList.filter((recipient) => suppressedByEmail.has(recipient.email)),
  };
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
  recordBusinessMetric("email", "failed");
}

/**
 * sendEmail(to, subject, html)
 * - Uses Resend API
 * - If RESEND_API_KEY missing -> logs and returns (safe dev mode)
 */
export async function sendEmail(to, subject, html, options = {}) {
  const recipients = normalizeRecipients(to);
  const localizedHtml = withEmailDirection(html, normalizeEmailLocale(options.locale));

  if (!recipients.length) {
    logger.warn({ to, subject }, "sendEmail called with no valid recipients");
    return;
  }

  const { allowed: toList, suppressed } = await filterSuppressedRecipients(recipients);
  if (suppressed.length) {
    recordBusinessMetric("email", "suppressed", { count: suppressed.length });
  }
  if (!toList.length) {
    logger.warn({ subject, suppressed: suppressed.map((recipient) => recipient.email) }, "Email skipped for suppressed recipients");
    return { sent: false, suppressed: true, deliveryId: null };
  }

  const delivery = options.track
    ? await prisma.notificationDelivery.create({
        data: {
          userId: options.userId || null,
          notificationId: options.notificationId || null,
          eventType: String(options.eventType || "email"),
          recipient: toList.map((recipient) => recipient.email).join(","),
          subject: String(subject || ""),
          bodyHtml: localizedHtml,
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
    const provider = await sendViaResend(toList, subject, localizedHtml);
    recordBusinessMetric("email", "sent");

    if (delivery) {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          providerMessageId: provider.providerMessageId,
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
 * Persist an email for the notification worker without contacting the provider
 * during the booking/cancellation request. The row is the durable handoff.
 */
export async function enqueueEmail(to, subject, html, options = {}) {
  const recipients = normalizeRecipients(to);
  const localizedHtml = withEmailDirection(html, normalizeEmailLocale(options.locale));

  if (!recipients.length) {
    logger.warn({ to, subject }, "enqueueEmail called with no valid recipients");
    return { queued: false, deliveryId: null };
  }

  let filtered;
  try {
    filtered = await filterSuppressedRecipients(recipients);
  } catch (error) {
    recordBusinessMetric("email", "queueFailures");
    void notifyOperationalAlert({
      key: "email-suppression-lookup-failed",
      severity: "critical",
      title: "Email suppression lookup failed",
      actual: error?.message || "database error",
    });
    throw error;
  }

  if (filtered.suppressed.length) {
    recordBusinessMetric("email", "suppressed", { count: filtered.suppressed.length });
  }
  if (!filtered.allowed.length) {
    logger.warn({ subject, suppressed: filtered.suppressed.map((recipient) => recipient.email) }, "Email not queued for suppressed recipients");
    return { queued: false, suppressed: true, deliveryId: null };
  }

  const toList = filtered.allowed;

  let delivery;
  try {
    delivery = await prisma.notificationDelivery.create({
      data: {
        userId: options.userId || null,
        notificationId: options.notificationId || null,
        eventType: String(options.eventType || "email"),
        recipient: toList.map((recipient) => recipient.email).join(","),
        subject: String(subject || ""),
        bodyHtml: localizedHtml,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
      select: { id: true },
    });
  } catch (error) {
    recordBusinessMetric("email", "queueFailures");
    void notifyOperationalAlert({
      key: "email-queue-write-failed",
      severity: "critical",
      title: "Transactional email could not be queued",
      actual: error?.message || "database error",
      context: { eventType: options.eventType || "email" },
    });
    throw error;
  }

  recordBusinessMetric("email", "queued");

  return { queued: true, deliveryId: delivery.id };
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
      const filtered = await filterSuppressedRecipients(
        normalizeRecipients(candidate.recipient)
      );
      if (!filtered.allowed.length) {
        await prisma.notificationDelivery.update({
          where: { id: candidate.id },
          data: {
            status: "SUPPRESSED",
            attempts: attempt,
            lastError: "Recipient is on the provider suppression list",
            lockedAt: null,
            lockedBy: null,
          },
        });
        recordBusinessMetric("email", "suppressed");
        continue;
      }
      const provider = await sendViaResend(
        filtered.allowed,
        candidate.subject,
        candidate.bodyHtml
      );
      await prisma.notificationDelivery.update({
        where: { id: candidate.id },
        data: {
          status: "SENT",
          providerMessageId: provider.providerMessageId,
          attempts: attempt,
          sentAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      succeeded += 1;
      recordBusinessMetric("email", "sent");
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

function normalizeProviderRecipients(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  return normalizeRecipients(value).map((recipient) => recipient.email);
}

/**
 * Apply a signed provider event to the durable delivery ledger. Bounce and
 * complaint events permanently suppress the address so later retries cannot
 * keep damaging sender reputation.
 */
export async function recordResendWebhookEvent(event = {}) {
  const type = String(event.type || "").toLowerCase();
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const eventId = String(event.id || "").trim() || null;
  const providerMessageId = String(data.email_id || data.id || "").trim() || null;
  const recipient = normalizeProviderRecipients(data.to || data.recipient || [])[0] || null;
  const eventAt = event.created_at || data.created_at || null;

  if (!type || (!eventId && !providerMessageId && !recipient)) {
    return { handled: false, reason: "missing_provider_event_identity" };
  }

  if (eventId && prisma.notificationDelivery) {
    const duplicate = await prisma.notificationDelivery.findFirst({
      where: { providerEventId: eventId },
      select: { id: true },
    });
    if (duplicate) return { handled: true, duplicate: true, deliveryId: duplicate.id };
  }

  const delivery = providerMessageId
    ? await prisma.notificationDelivery.findFirst({
        where: { providerMessageId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    : recipient
      ? await prisma.notificationDelivery.findFirst({
          where: { recipient: { contains: recipient } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : null;

  const isBounce = type.includes("bounced");
  const isComplaint = type.includes("complained") || type.includes("complaint");
  const isDelivered = type.includes("delivered") || type.endsWith(".sent");
  const isFailed = type.includes("failed");
  const nextStatus = isBounce ? "BOUNCED" : isComplaint ? "COMPLAINED" : isFailed ? "FAILED" : isDelivered ? "SENT" : null;

  if (delivery && nextStatus) {
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: nextStatus,
        providerMessageId: providerMessageId || undefined,
        providerEventId: eventId || undefined,
        providerEventType: type,
        providerEventAt: eventAt ? new Date(eventAt) : new Date(),
        sentAt: nextStatus === "SENT" ? (delivery.sentAt || new Date()) : undefined,
        lastError: isBounce || isComplaint || isFailed
          ? String(data.reason || data.message || type).slice(0, 1000)
          : undefined,
        lockedAt: null,
        lockedBy: null,
      },
    });
  }

  if ((isBounce || isComplaint) && recipient && prisma.emailSuppression) {
    await prisma.emailSuppression.upsert({
      where: { email: recipient },
      update: {
        reason: isComplaint ? "complaint" : "bounce",
        source: "resend",
        providerEventId: eventId,
        lastEventAt: eventAt ? new Date(eventAt) : new Date(),
      },
      create: {
        email: recipient,
        reason: isComplaint ? "complaint" : "bounce",
        source: "resend",
        providerEventId: eventId,
        lastEventAt: eventAt ? new Date(eventAt) : new Date(),
      },
    });
    recordBusinessMetric("email", isComplaint ? "complained" : "bounced");
    void notifyOperationalAlert({
      key: isComplaint ? "email-complaint" : "email-bounce",
      severity: "warning",
      title: isComplaint ? "Email complaint received" : "Email bounce received",
      actual: recipient,
      context: { eventType: type, deliveryId: delivery?.id || null },
    });
  }

  return { handled: true, deliveryId: delivery?.id || null, status: nextStatus };
}
