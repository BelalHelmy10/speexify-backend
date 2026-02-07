// src/routes/support/shared.js
import { z } from "zod";
import path from "path";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { consumeRateLimit } from "../../services/rateLimitService.js";

export const SUPPORT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "support");
export const SUPPORT_TICKETS_DEFAULT_LIMIT = 50;
export const SUPPORT_TICKETS_MAX_LIMIT = 200;
export const SUPPORT_TICKETS_MAX_OFFSET = 10000;

export const CategorySchema = z.enum([
  "PAYMENT",
  "BOOKING",
  "CLASSROOM_TECH",
  "ACCOUNT",
  "OTHER",
]);

export const PrioritySchema = z
  .enum(["LOW", "NORMAL", "HIGH", "URGENT"])
  .default("NORMAL");

export async function checkRateLimit(userId, action, maxAttempts, windowMs) {
  const result = await consumeRateLimit({
    key: `support:user:${Number(userId)}:${String(action || "").slice(0, 120)}`,
    limit: Number(maxAttempts),
    windowMs: Number(windowMs),
  });
  return result.allowed;
}

export function sanitizeDownloadName(fileName) {
  const sanitized = String(fileName || "attachment")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || "attachment";
}

export function parseBoundedInt(
  value,
  { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export async function loadAttachmentAccessContext(attachmentId, viewerId, isAdmin) {
  const attachment = await prisma.supportAttachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      fileName: true,
      filePath: true,
      mimeType: true,
      fileSize: true,
      message: {
        select: {
          ticket: {
            select: {
              id: true,
              userId: true,
            },
          },
        },
      },
    },
  });

  const ticket = attachment?.message?.ticket || null;
  if (!attachment || !ticket) {
    return { allowed: false, status: 404, error: "Attachment not found" };
  }

  if (!isAdmin && ticket.userId !== viewerId) {
    return { allowed: false, status: 403, error: "Forbidden" };
  }

  return { allowed: true, attachment, ticket };
}

export async function requireTicketAccess(req, res, next) {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId)) {
    return res.status(400).json({ error: "Invalid ticket id" });
  }

  const viewerId = req.viewUserId;
  const isAdmin = req.user?.role === "admin";

  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, status: true },
    });

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    if (!isAdmin && ticket.userId !== viewerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    req.supportAccess = { ticketId, ticket, viewerId, isAdmin };
    return next();
  } catch (err) {
    logger.error({ err, ticketId }, "Failed to validate support ticket access");
    return res.status(500).json({ error: "Failed to validate ticket access" });
  }
}
