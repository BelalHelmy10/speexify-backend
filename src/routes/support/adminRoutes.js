// src/routes/support/adminRoutes.js
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { formatZodError } from "../../middleware/validateRequest.js";
import { logger } from "../../lib/logger.js";
import {
  broadcastNewMessage,
  broadcastTicketStatusChange,
} from "../../services/supportWebSocket.js";
import {
  SUPPORT_TICKETS_DEFAULT_LIMIT,
  SUPPORT_TICKETS_MAX_LIMIT,
  SUPPORT_TICKETS_MAX_OFFSET,
  parseBoundedInt,
} from "./shared.js";

const router = Router();

// ADMIN: UPDATE PRIORITY
router.patch(
  "/admin/tickets/:ticketId/priority",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { ticketId } = req.params;
    const { priority } = req.body;

    const validPriorities = ["LOW", "NORMAL", "HIGH", "URGENT"];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({
        error: "Invalid priority. Must be: LOW, NORMAL, HIGH, or URGENT",
      });
    }

    try {
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
      return res.json({ ticket });
    } catch (error) {
      console.error("❌ Failed to update ticket priority:", error);
      return res.status(500).json({ error: "Failed to update priority" });
    }
  }
);

// ADMIN: ASSIGN TICKET TO STAFF
router.patch(
  "/admin/tickets/:ticketId/assign",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { ticketId } = req.params;
    const { assignedToId } = req.body;

    try {
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
      return res.json({ ticket });
    } catch (error) {
      console.error("❌ Failed to assign ticket:", error);
      return res.status(500).json({ error: "Failed to assign ticket" });
    }
  }
);

// ADMIN: ADD INTERNAL NOTE (Staff-Only Collaboration)
router.post(
  "/admin/tickets/:ticketId/notes",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { ticketId } = req.params;
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ error: "Note content is required" });
    }

    try {
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
      return res.json({ note: internalNote });
    } catch (error) {
      console.error("❌ Failed to add internal note:", error);
      return res.status(500).json({ error: "Failed to add internal note" });
    }
  }
);

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

    return res.json({
      ok: true,
      tickets: normalized,
      total,
      limit: take,
      offset: skip,
    });
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
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
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

      const updatedTicket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: ticket.status === "OPEN" ? "IN_PROGRESS" : undefined,
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });

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
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
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
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
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
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
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
