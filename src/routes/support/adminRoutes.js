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
  getSupportSlaDueAt,
  parseBoundedInt,
} from "./shared.js";

const router = Router();

function getAdminQueueWhere(queue, adminId) {
  const now = new Date();
  switch (queue) {
    case "active":
      return { status: { not: "RESOLVED" } };
    case "mine":
      return { assignedToId: adminId, status: { not: "RESOLVED" } };
    case "unassigned":
      return { assignedToId: null, status: { not: "RESOLVED" } };
    case "urgent":
      return { priority: "URGENT", status: { not: "RESOLVED" } };
    case "overdue":
      return { slaDueAt: { lt: now }, status: { not: "RESOLVED" } };
    case "resolved":
      return { status: "RESOLVED" };
    case "waiting":
      return { status: "IN_PROGRESS", lastStaffReplyAt: { not: null } };
    default:
      return {};
  }
}

function getStatusTimestampPatch(nextStatus, previousStatus) {
  if (nextStatus === "RESOLVED") {
    const now = new Date();
    return {
      resolvedAt: now,
      closedAt: now,
    };
  }

  if (previousStatus === "RESOLVED") {
    return {
      resolvedAt: null,
      closedAt: null,
      reopenedAt: new Date(),
      reopenCount: { increment: 1 },
    };
  }

  return {};
}

// GET /api/support/admin/tickets - List all tickets
router.get("/admin/tickets", requireAuth, requireAdmin, async (req, res) => {
  const adminId = Number(req.user?.id);
  const status = req.query.status ? String(req.query.status) : null;
  const priority = req.query.priority ? String(req.query.priority) : null;
  const queue = req.query.queue ? String(req.query.queue) : "";
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
      ...getAdminQueueWhere(queue, adminId),
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
          firstResponseAt: true,
          lastCustomerReplyAt: true,
          lastStaffReplyAt: true,
          slaDueAt: true,
          closedAt: true,
          reopenedAt: true,
          reopenCount: true,
          satisfactionRating: true,
          tags: true,
          source: true,
          relatedSessionId: true,
          relatedPaymentId: true,
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

    const [active, mine, unassigned, urgent, overdue, waiting, resolved] =
      await prisma.$transaction([
        prisma.supportTicket.count({
          where: { status: { not: "RESOLVED" } },
        }),
        prisma.supportTicket.count({
          where: {
            assignedToId: adminId,
            status: { not: "RESOLVED" },
          },
        }),
        prisma.supportTicket.count({
          where: { assignedToId: null, status: { not: "RESOLVED" } },
        }),
        prisma.supportTicket.count({
          where: { priority: "URGENT", status: { not: "RESOLVED" } },
        }),
        prisma.supportTicket.count({
          where: { slaDueAt: { lt: new Date() }, status: { not: "RESOLVED" } },
        }),
        prisma.supportTicket.count({
          where: { status: "IN_PROGRESS", lastStaffReplyAt: { not: null } },
        }),
        prisma.supportTicket.count({ where: { status: "RESOLVED" } }),
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
      summary: { active, mine, unassigned, urgent, overdue, waiting, resolved },
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
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              timezone: true,
              createdAt: true,
              userPackages: {
                orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
                take: 4,
                select: {
                  id: true,
                  title: true,
                  status: true,
                  sessionsTotal: true,
                  sessionsUsed: true,
                  expiresAt: true,
                },
              },
              orders: {
                orderBy: { createdAt: "desc" },
                take: 4,
                select: {
                  id: true,
                  status: true,
                  amountCents: true,
                  currency: true,
                  createdAt: true,
                  package: { select: { title: true } },
                },
              },
              sessions: {
                orderBy: { startAt: "desc" },
                take: 4,
                select: {
                  id: true,
                  title: true,
                  startAt: true,
                  status: true,
                },
              },
              supportTickets: {
                orderBy: { updatedAt: "desc" },
                take: 5,
                select: {
                  id: true,
                  subject: true,
                  status: true,
                  priority: true,
                  updatedAt: true,
                },
              },
            },
          },
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

    const adminId = Number(req.user.id);

    try {
      const ticket = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, status: true, userId: true, firstResponseAt: true },
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
          firstResponseAt: ticket.firstResponseAt ? undefined : new Date(),
          lastStaffReplyAt: new Date(),
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

    const adminId = Number(req.user.id);

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
          ...getStatusTimestampPatch(nextStatus, prevStatus),
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
            body: "Ticket marked as resolved. Reply here if you still need help.",
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

// PATCH /api/support/admin/tickets/:id/priority - Update priority
router.patch(
  "/admin/tickets/:id/priority",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    const Body = z
      .object({
        priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
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
      const priority = parsed.data.priority;
      const ticket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          priority,
          slaDueAt: getSupportSlaDueAt(priority),
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      });

      broadcastTicketStatusChange(ticketId, ticket.status, ticket);
      logger.info({ ticketId, priority }, "Ticket priority updated");

      return res.json({ ok: true, ticket });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Failed to update priority");
      return res.status(500).json({ error: "Failed to update priority" });
    }
  }
);

// PATCH /api/support/admin/tickets/:id/tags - Update tags
router.patch(
  "/admin/tickets/:id/tags",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    const Body = z
      .object({
        tags: z
          .array(z.string().trim().min(1).max(32))
          .max(8)
          .default([]),
      })
      .strict();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
    }

    const tags = Array.from(
      new Set(parsed.data.tags.map((tag) => tag.toLowerCase()))
    );

    try {
      const ticket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: { tags },
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      });

      broadcastTicketStatusChange(ticketId, ticket.status, ticket);
      logger.info({ ticketId, tags }, "Ticket tags updated");
      return res.json({ ok: true, ticket });
    } catch (e) {
      logger.error({ err: e, ticketId }, "Failed to update ticket tags");
      return res.status(500).json({ error: "Failed to update tags" });
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
          authorId: Number(req.user.id),
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
