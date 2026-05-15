// src/routes/support/userRoutes.js
import fs from "fs";
import path from "path";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth-helpers.js";
import { formatZodError } from "../../middleware/validateRequest.js";
import {
  supportUpload,
  validateUploadedFile,
  deleteFile,
} from "../../lib/supportUpload.js";
import { logger } from "../../lib/logger.js";
import {
  broadcastNewMessage,
  broadcastNewTicket,
} from "../../services/supportWebSocket.js";
import {
  SUPPORT_UPLOAD_DIR,
  SUPPORT_TICKETS_DEFAULT_LIMIT,
  SUPPORT_TICKETS_MAX_LIMIT,
  SUPPORT_TICKETS_MAX_OFFSET,
  CategorySchema,
  PrioritySchema,
  checkRateLimit,
  getAttachmentMessageBody,
  getDefaultSupportTags,
  getSupportSlaDueAt,
  parseBoundedInt,
  sanitizeDownloadName,
  loadAttachmentAccessContext,
  requireTicketAccess,
} from "./shared.js";

const router = Router();

// POST /api/support/tickets - Create ticket
router.post("/tickets", requireAuth, async (req, res) => {
  const userId = req.viewUserId;

  if (!(await checkRateLimit(userId, "create_ticket", 3, 60 * 60 * 1000))) {
    return res.status(429).json({
      error: "Too many tickets. Please wait before creating another.",
    });
  }

  const Body = z
    .object({
      category: CategorySchema,
      subject: z.string().trim().max(140).optional().nullable(),
      message: z.string().trim().min(1).max(5000),
      priority: PrioritySchema.optional(),
      source: z.string().trim().max(40).optional(),
      relatedSessionId: z.number().int().positive().optional().nullable(),
      relatedPaymentId: z.number().int().positive().optional().nullable(),
    })
    .strict();

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: formatZodError(parsed.error, "body"),
    });
  }

  const {
    category,
    subject,
    message,
    priority = "NORMAL",
    source = "widget",
    relatedSessionId = null,
    relatedPaymentId = null,
  } = parsed.data;
  const now = new Date();

  try {
    const ticket = await prisma.supportTicket.create({
      data: {
        userId,
        category,
        subject: subject || null,
        priority,
        source,
        relatedSessionId,
        relatedPaymentId,
        lastCustomerReplyAt: now,
        slaDueAt: getSupportSlaDueAt(priority, now),
        tags: getDefaultSupportTags(category),
        messages: {
          create: {
            authorId: userId,
            body: message,
            isStaff: false,
          },
        },
      },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            author: { select: { id: true, name: true, role: true } },
            attachments: true,
          },
        },
      },
    });

    broadcastNewTicket(ticket);
    logger.info({ ticketId: ticket.id, userId }, "Support ticket created");
    return res.json({ ok: true, ticket });
  } catch (e) {
    logger.error({ err: e, userId }, "Failed to create ticket");
    return res.status(500).json({ error: "Failed to create ticket" });
  }
});

// GET /api/support/tickets - List user's tickets
router.get("/tickets", requireAuth, async (req, res) => {
  const userId = req.viewUserId;
  const take = parseBoundedInt(req.query.limit, {
    fallback: SUPPORT_TICKETS_DEFAULT_LIMIT,
    min: 1,
    max: SUPPORT_TICKETS_MAX_LIMIT,
  });
  const skip = parseBoundedInt(req.query.offset, {
    fallback: 0,
    min: 0,
    max: SUPPORT_TICKETS_MAX_OFFSET,
  });

  try {
    const [tickets, total] = await prisma.$transaction([
      prisma.supportTicket.findMany({
        where: { userId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take,
        skip,
        select: {
          id: true,
          category: true,
          subject: true,
          status: true,
          priority: true,
          assignedToId: true,
          assignedTo: {
            select: { id: true, name: true, email: true },
          },
          createdAt: true,
          updatedAt: true,
          messages: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              id: true,
              body: true,
              createdAt: true,
              isStaff: true,
              authorId: true,
            },
          },
        },
      }),
      prisma.supportTicket.count({ where: { userId } }),
    ]);

    const normalized = tickets.map((t) => ({
      ...t,
      lastMessage: t.messages[0] || null,
      messages: undefined,
    }));

    return res.json({
      ok: true,
      tickets: normalized,
      total,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    logger.error({ err: e, userId }, "Failed to list tickets");
    return res.status(500).json({ error: "Failed to list tickets" });
  }
});

// GET /api/support/tickets/:id - Get ticket details
router.get("/tickets/:id", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId)) {
    return res.status(400).json({ error: "Invalid ticket id" });
  }

  const viewerId = req.viewUserId;
  const isAdmin = req.user?.role === "admin";

  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          take: 50,
          include: {
            author: { select: { id: true, name: true, role: true } },
            attachments: true,
          },
        },
        internalNotes: {
          orderBy: { createdAt: "desc" },
          include: {
            author: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    if (!isAdmin && ticket.userId !== viewerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!isAdmin) {
      delete ticket.internalNotes;
    }

    return res.json({ ok: true, ticket });
  } catch (e) {
    logger.error({ err: e, ticketId }, "Failed to read ticket");
    return res.status(500).json({ error: "Failed to read ticket" });
  }
});

// POST /api/support/tickets/:id/messages - Add message
router.post("/tickets/:id/messages", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId)) {
    return res.status(400).json({ error: "Invalid ticket id" });
  }

  const userId = req.viewUserId;
  if (!(await checkRateLimit(userId, `message_${ticketId}`, 10, 60 * 1000))) {
    return res.status(429).json({
      error: "Too many messages. Please slow down.",
    });
  }

  const Body = z
    .object({
      body: z.string().trim().min(1).max(5000),
    })
    .strict();

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: formatZodError(parsed.error, "body"),
    });
  }

  const viewerId = req.viewUserId;
  const isAdmin = req.user?.role === "admin";

  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, status: true, firstResponseAt: true },
    });

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    if (!isAdmin && ticket.userId !== viewerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const message = await prisma.supportMessage.create({
      data: {
        ticketId,
        authorId: viewerId,
        body: parsed.data.body,
        isStaff: isAdmin,
      },
      include: {
        author: { select: { id: true, name: true, role: true } },
        attachments: true,
      },
    });

    const updatedTicket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: ticket.status === "RESOLVED" && !isAdmin ? "OPEN" : undefined,
        resolvedAt: ticket.status === "RESOLVED" && !isAdmin ? null : undefined,
        closedAt: ticket.status === "RESOLVED" && !isAdmin ? null : undefined,
        reopenedAt:
          ticket.status === "RESOLVED" && !isAdmin ? new Date() : undefined,
        reopenCount:
          ticket.status === "RESOLVED" && !isAdmin
            ? { increment: 1 }
            : undefined,
        lastCustomerReplyAt: !isAdmin ? new Date() : undefined,
        lastStaffReplyAt: isAdmin ? new Date() : undefined,
        firstResponseAt:
          isAdmin && !ticket.firstResponseAt ? new Date() : undefined,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });

    broadcastNewMessage(ticketId, message, updatedTicket);
    logger.info({ ticketId, messageId: message.id }, "Message added");
    return res.json({ ok: true, message });
  } catch (e) {
    logger.error({ err: e, ticketId }, "Failed to add message");
    return res.status(500).json({ error: "Failed to add message" });
  }
});

// POST /api/support/tickets/:id/attachments - Upload attachment
router.post(
  "/tickets/:id/attachments",
  requireAuth,
  requireTicketAccess,
  supportUpload.single("file"),
  validateUploadedFile,
  async (req, res) => {
    const { ticketId, viewerId, isAdmin } = req.supportAccess || {};

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      const message = await prisma.supportMessage.create({
        data: {
          ticketId,
          authorId: viewerId,
          body: getAttachmentMessageBody(req.file),
          isStaff: isAdmin,
          attachments: {
            create: {
              fileName: req.file.originalname,
              filePath: req.file.filename,
              mimeType: req.file.mimetype,
              fileSize: req.file.size,
            },
          },
        },
        include: {
          attachments: true,
          author: { select: { id: true, name: true, role: true } },
        },
      });

      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          lastCustomerReplyAt: !isAdmin ? new Date() : undefined,
          lastStaffReplyAt: isAdmin ? new Date() : undefined,
          firstResponseAt:
            isAdmin && !req.supportAccess?.ticket?.firstResponseAt
              ? new Date()
              : undefined,
        },
      });

      const updatedTicket = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });

      broadcastNewMessage(ticketId, message, updatedTicket);
      logger.info(
        { ticketId, fileName: req.file.originalname },
        "Attachment uploaded"
      );

      return res.json({ ok: true, message });
    } catch (err) {
      if (req.file?.filename) {
        deleteFile(req.file.filename);
      }
      logger.error({ err, ticketId }, "Failed to upload attachment");
      return res.status(500).json({ error: "Failed to upload attachment" });
    }
  }
);

// POST /api/support/tickets/:id/satisfaction - Rate a resolved ticket
router.post("/tickets/:id/satisfaction", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId)) {
    return res.status(400).json({ error: "Invalid ticket id" });
  }

  const Body = z
    .object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().max(1000).optional().nullable(),
    })
    .strict();

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: formatZodError(parsed.error, "body"),
    });
  }

  const viewerId = req.viewUserId;

  try {
    const existing = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, status: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    if (existing.userId !== viewerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (existing.status !== "RESOLVED") {
      return res.status(400).json({
        error: "Only resolved tickets can be rated.",
      });
    }

    const ticket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        satisfactionRating: parsed.data.rating,
        satisfactionComment: parsed.data.comment || null,
      },
    });

    return res.json({ ok: true, ticket });
  } catch (e) {
    logger.error({ err: e, ticketId }, "Failed to save ticket satisfaction");
    return res.status(500).json({ error: "Failed to save rating" });
  }
});

// GET /api/support/attachments/:attachmentId - Authorized attachment download
router.get("/attachments/:attachmentId", requireAuth, async (req, res) => {
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isFinite(attachmentId)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }

  const viewerId = req.viewUserId;
  const isAdmin = req.user?.role === "admin";

  try {
    const access = await loadAttachmentAccessContext(
      attachmentId,
      viewerId,
      isAdmin
    );

    if (!access.allowed) {
      return res.status(access.status).json({ error: access.error });
    }

    const { attachment } = access;
    const safeStoredName = path.basename(String(attachment.filePath || ""));
    const absolutePath = path.join(SUPPORT_UPLOAD_DIR, safeStoredName);

    if (!safeStoredName || !fs.existsSync(absolutePath)) {
      logger.warn(
        { attachmentId, filePath: attachment.filePath },
        "Support attachment file missing on disk"
      );
      return res.status(404).json({ error: "Attachment file not found" });
    }

    const stats = fs.statSync(absolutePath);
    const mimeType = attachment.mimeType || "application/octet-stream";
    const disposition = mimeType.startsWith("image/") ? "inline" : "attachment";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${sanitizeDownloadName(attachment.fileName)}"`
    );
    res.setHeader("Cache-Control", "private, max-age=300");

    return res.sendFile(absolutePath);
  } catch (err) {
    logger.error({ err, attachmentId }, "Failed to serve support attachment");
    return res.status(500).json({ error: "Failed to serve attachment" });
  }
});

export default router;
