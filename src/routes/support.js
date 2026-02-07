// src/routes/support.js
// IMPROVED: Real-time WebSocket support, enterprise features, better security

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import {
  supportUpload,
  validateUploadedFile,
  deleteFile,
} from "../lib/supportUpload.js";
import { logger } from "../lib/logger.js";
import fs from "fs";
import path from "path";
import { consumeRateLimit } from "../services/rateLimitService.js";
import {
  broadcastNewMessage,
  broadcastTicketStatusChange,
  broadcastNewTicket,
} from "../services/supportWebSocket.js";

const router = Router();
const SUPPORT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "support");
const SUPPORT_TICKETS_DEFAULT_LIMIT = 50;
const SUPPORT_TICKETS_MAX_LIMIT = 200;
const SUPPORT_TICKETS_MAX_OFFSET = 10000;

const CategorySchema = z.enum([
  "PAYMENT",
  "BOOKING",
  "CLASSROOM_TECH",
  "ACCOUNT",
  "OTHER",
]);

const PrioritySchema = z
  .enum(["LOW", "NORMAL", "HIGH", "URGENT"])
  .default("NORMAL");

// ============================================================================
// HELPER: Rate limiting
// ============================================================================
async function checkRateLimit(userId, action, maxAttempts, windowMs) {
  const result = await consumeRateLimit({
    key: `support:user:${Number(userId)}:${String(action || "").slice(0, 120)}`,
    limit: Number(maxAttempts),
    windowMs: Number(windowMs),
  });
  return result.allowed;
}

function sanitizeDownloadName(fileName) {
  const sanitized = String(fileName || "attachment")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || "attachment";
}

function parseBoundedInt(value, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function loadAttachmentAccessContext(attachmentId, viewerId, isAdmin) {
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

async function requireTicketAccess(req, res, next) {
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

// ============================================================================
// POST /api/support/tickets - Create ticket
// ============================================================================
router.post("/tickets", requireAuth, async (req, res) => {
  const userId = req.viewUserId;

  // Rate limit: 3 tickets per hour
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
    })
    .strict();

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid data",
      details: parsed.error.errors,
    });
  }

  const { category, subject, message, priority } = parsed.data;

  try {
    const ticket = await prisma.supportTicket.create({
      data: {
        userId,
        category,
        subject: subject || null,
        priority: priority || "NORMAL",
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

    // Broadcast to admins
    broadcastNewTicket(ticket);

    logger.info({ ticketId: ticket.id, userId }, "Support ticket created");

    return res.json({ ok: true, ticket });
  } catch (e) {
    logger.error({ err: e, userId }, "Failed to create ticket");
    return res.status(500).json({ error: "Failed to create ticket" });
  }
});

// ============================================================================
// GET /api/support/tickets - List user's tickets
// ============================================================================
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

    return res.json({ ok: true, tickets: normalized, total, limit: take, offset: skip });
  } catch (e) {
    logger.error({ err: e, userId }, "Failed to list tickets");
    return res.status(500).json({ error: "Failed to list tickets" });
  }
});

// ============================================================================
// GET /api/support/tickets/:id - Get ticket details
// ============================================================================
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
          take: 50, // Pagination: load last 50 messages
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

    // Don't send internal notes to regular users
    if (!isAdmin) {
      delete ticket.internalNotes;
    }

    return res.json({ ok: true, ticket });
  } catch (e) {
    logger.error({ err: e, ticketId }, "Failed to read ticket");
    return res.status(500).json({ error: "Failed to read ticket" });
  }
});

// ============================================================================
// POST /api/support/tickets/:id/messages - Add message
// ============================================================================
router.post("/tickets/:id/messages", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId)) {
    return res.status(400).json({ error: "Invalid ticket id" });
  }

  const userId = req.viewUserId;

  // Rate limit: 10 messages per minute
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
    return res.status(400).json({ error: "Invalid message" });
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

    // Update ticket
    const updatedTicket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: ticket.status === "RESOLVED" && !isAdmin ? "OPEN" : undefined,
        resolvedAt: ticket.status === "RESOLVED" && !isAdmin ? null : undefined,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });

    // Broadcast via WebSocket
    broadcastNewMessage(ticketId, message, updatedTicket);

    logger.info({ ticketId, messageId: message.id }, "Message added");

    return res.json({ ok: true, message });
  } catch (e) {
    logger.error({ err: e, ticketId }, "Failed to add message");
    return res.status(500).json({ error: "Failed to add message" });
  }
});

// ============================================================================
// POST /api/support/tickets/:id/attachments - Upload attachment
// ============================================================================
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
      // Create message with attachment
      const message = await prisma.supportMessage.create({
        data: {
          ticketId,
          authorId: viewerId,
          body: `[Image: ${req.file.originalname}]`,
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

      // Broadcast
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

      res.json({ ok: true, message });
    } catch (err) {
      if (req.file?.filename) {
        deleteFile(req.file.filename);
      }
      logger.error({ err, ticketId }, "Failed to upload attachment");
      res.status(500).json({ error: "Failed to upload attachment" });
    }
  }
);

// ============================================================================
// GET /api/support/attachments/:attachmentId - Authorized attachment download
// ============================================================================
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

// ============================================================================
// COPY THIS ENTIRE SECTION INTO YOUR backend/routes/support.js
// Add it BEFORE your existing admin routes
// ============================================================================

// ============================================================================
// ADMIN: UPDATE PRIORITY
// ============================================================================
router.patch(
  "/admin/tickets/:ticketId/priority",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { ticketId } = req.params;
    const { priority } = req.body;

    // Validate priority
    const validPriorities = ["LOW", "NORMAL", "HIGH", "URGENT"];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({
        error: "Invalid priority. Must be: LOW, NORMAL, HIGH, or URGENT",
      });
    }

    try {
      // Update ticket with new priority
      const ticket = await prisma.supportTicket.update({
        where: { id: parseInt(ticketId) },
        data: { priority },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
          messages: {
            orderBy: { createdAt: "asc" },
            include: {
              attachments: true,
            },
          },
          assignedTo: {
            select: { id: true, name: true, email: true },
          },
          internalNotes: {
            orderBy: { createdAt: "desc" },
            include: {
              author: {
                select: { id: true, name: true, email: true },
              },
            },
          },
        },
      });

      console.log(`✅ Ticket #${ticketId} priority updated to ${priority}`);
      res.json({ ticket });
    } catch (error) {
      console.error("❌ Failed to update ticket priority:", error);
      res.status(500).json({ error: "Failed to update priority" });
    }
  }
);

// ============================================================================
// ADMIN: ASSIGN TICKET TO STAFF
// ============================================================================
router.patch(
  "/admin/tickets/:ticketId/assign",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { ticketId } = req.params;
    const { assignedToId } = req.body;

    try {
      // Update ticket assignment
      const ticket = await prisma.supportTicket.update({
        where: { id: parseInt(ticketId) },
        data: {
          assignedToId: assignedToId ? parseInt(assignedToId) : null,
        },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
          messages: {
            orderBy: { createdAt: "asc" },
            include: {
              attachments: true,
            },
          },
          assignedTo: {
            select: { id: true, name: true, email: true },
          },
          internalNotes: {
            orderBy: { createdAt: "desc" },
            include: {
              author: {
                select: { id: true, name: true, email: true },
              },
            },
          },
        },
      });

      console.log(
        `✅ Ticket #${ticketId} assigned to ${assignedToId || "unassigned"}`
      );
      res.json({ ticket });
    } catch (error) {
      console.error("❌ Failed to assign ticket:", error);
      res.status(500).json({ error: "Failed to assign ticket" });
    }
  }
);

// ============================================================================
// ADMIN: ADD INTERNAL NOTE (Staff-Only Collaboration)
// ============================================================================
router.post(
  "/admin/tickets/:ticketId/notes",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { ticketId } = req.params;
    const { note } = req.body;

    // Validate note content
    if (!note || !note.trim()) {
      return res.status(400).json({ error: "Note content is required" });
    }

    try {
      // Create internal note
      const internalNote = await prisma.supportInternalNote.create({
        data: {
          ticketId: parseInt(ticketId),
          authorId: req.user.id,
          body: note.trim(),
        },
        include: {
          author: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      console.log(
        `✅ Internal note added to ticket #${ticketId} by ${req.user.email}`
      );
      res.json({ note: internalNote });
    } catch (error) {
      console.error("❌ Failed to add internal note:", error);
      res.status(500).json({ error: "Failed to add internal note" });
    }
  }
);

// ============================================================================
// YOUR EXISTING ADMIN ROUTES GO BELOW THIS
// ============================================================================

// ============================================================================
// ADMIN ROUTES
// ============================================================================

// GET /api/support/admin/tickets - List all tickets
router.get("/admin/tickets", requireAuth, requireAdmin, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const priority = req.query.priority ? String(req.query.priority) : null;
  const assignedToId = req.query.assignedToId
    ? Number(req.query.assignedToId)
    : null;
  const q = req.query.q ? String(req.query.q).trim() : "";
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

  const allowedStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED"];
  const allowedPriorities = ["LOW", "NORMAL", "HIGH", "URGENT"];

  const statusFilter =
    status && allowedStatuses.includes(status) ? status : null;
  const priorityFilter =
    priority && allowedPriorities.includes(priority) ? priority : null;

  try {
    const where = {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(priorityFilter ? { priority: priorityFilter } : {}),
      ...(assignedToId ? { assignedToId } : {}),
      ...(q
        ? {
            OR: [
              { subject: { contains: q, mode: "insensitive" } },
              { user: { email: { contains: q, mode: "insensitive" } } },
              { user: { name: { contains: q, mode: "insensitive" } } },
              {
                messages: {
                  some: { body: { contains: q, mode: "insensitive" } },
                },
              },
            ],
          }
        : {}),
    };

    const [tickets, total] = await prisma.$transaction([
      prisma.supportTicket.findMany({
        where,
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
          userId: true,
          user: { select: { id: true, name: true, email: true } },
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
      prisma.supportTicket.count({ where }),
    ]);

    const normalized = tickets.map((t) => ({
      ...t,
      lastMessage: t.messages[0] || null,
      messages: undefined,
    }));

    return res.json({ ok: true, tickets: normalized, total, limit: take, offset: skip });
  } catch (e) {
    logger.error({ err: e }, "Admin failed to list tickets");
    return res.status(500).json({ error: "Failed to list tickets" });
  }
});

// GET /api/support/admin/tickets/:id - Get ticket (admin)
router.get(
  "/admin/tickets/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    try {
      const ticket = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          messages: {
            orderBy: { createdAt: "asc" },
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

      return res.json({ ok: true, ticket });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Admin failed to read ticket");
      return res.status(500).json({ error: "Failed to read ticket" });
    }
  }
);

// POST /api/support/admin/tickets/:id/reply - Admin reply
router.post(
  "/admin/tickets/:id/reply",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    const Body = z
      .object({
        message: z.string().trim().min(1).max(5000),
      })
      .strict();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid message" });
    }

    const adminId = req.viewUserId;

    try {
      const ticket = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, status: true, userId: true },
      });

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const message = await prisma.supportMessage.create({
        data: {
          ticketId,
          authorId: adminId,
          body: parsed.data.message,
          isStaff: true,
        },
        include: {
          author: { select: { id: true, name: true, role: true } },
          attachments: true,
        },
      });

      // Auto-progress to IN_PROGRESS
      const updatedTicket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: ticket.status === "OPEN" ? "IN_PROGRESS" : undefined,
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });

      // Broadcast
      broadcastNewMessage(ticketId, message, updatedTicket);

      logger.info({ ticketId, adminId }, "Admin replied");

      return res.json({ ok: true, message });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Admin reply failed");
      return res.status(500).json({ error: "Failed to send reply" });
    }
  }
);

// PATCH /api/support/admin/tickets/:id/status - Update status
router.patch(
  "/admin/tickets/:id/status",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    const Body = z
      .object({
        status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]),
      })
      .strict();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const adminId = req.viewUserId;

    try {
      const nextStatus = parsed.data.status;

      const existing = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, status: true, userId: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const prevStatus = existing.status;

      const ticket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: nextStatus,
          resolvedAt: nextStatus === "RESOLVED" ? new Date() : null,
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      });

      // Add system message when resolved
      if (nextStatus === "RESOLVED" && prevStatus !== "RESOLVED") {
        await prisma.supportMessage.create({
          data: {
            ticketId,
            authorId: adminId,
            isStaff: true,
            body: "✅ Ticket marked as resolved. Reply here if you still need help.",
          },
        });
      }

      // Broadcast
      broadcastTicketStatusChange(ticketId, nextStatus, ticket);

      logger.info(
        { ticketId, prevStatus, nextStatus },
        "Ticket status updated"
      );

      return res.json({ ok: true, ticket });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Failed to update status");
      return res.status(500).json({ error: "Failed to update status" });
    }
  }
);

// PATCH /api/support/admin/tickets/:id/assign - Assign ticket
router.patch(
  "/admin/tickets/:id/assign",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    const Body = z
      .object({
        assignedToId: z.number().nullable(),
      })
      .strict();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid assignment" });
    }

    try {
      const ticket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          assignedToId: parsed.data.assignedToId,
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      });

      // Broadcast
      broadcastTicketStatusChange(ticketId, ticket.status, ticket);

      logger.info(
        { ticketId, assignedToId: parsed.data.assignedToId },
        "Ticket assigned"
      );

      return res.json({ ok: true, ticket });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Failed to assign ticket");
      return res.status(500).json({ error: "Failed to assign ticket" });
    }
  }
);

// POST /api/support/admin/tickets/:id/notes - Add internal note
router.post(
  "/admin/tickets/:id/notes",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    const Body = z
      .object({
        note: z.string().trim().min(1).max(2000),
      })
      .strict();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid note" });
    }

    try {
      const note = await prisma.supportInternalNote.create({
        data: {
          ticketId,
          authorId: req.viewUserId,
          body: parsed.data.note,
        },
        include: {
          author: { select: { id: true, name: true } },
        },
      });

      logger.info({ ticketId, noteId: note.id }, "Internal note added");

      return res.json({ ok: true, note });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Failed to add note");
      return res.status(500).json({ error: "Failed to add note" });
    }
  }
);

export default router;
