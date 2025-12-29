// src/routes/support.js
// In-app support: chat-style UI backed by tickets + thread messages

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { supportUpload } from "../lib/supportUpload.js";

const router = Router();

const CategorySchema = z.enum([
  "PAYMENT",
  "BOOKING",
  "CLASSROOM_TECH",
  "ACCOUNT",
  "OTHER",
]);

// ---------------------------------------------------------------------------
// POST /api/support/tickets
// Creates a ticket and the first message in a single call.
// ---------------------------------------------------------------------------
router.post("/tickets", requireAuth, async (req, res) => {
  const Body = z
    .object({
      category: CategorySchema,
      subject: z.string().trim().max(140).optional().nullable(),
      message: z.string().trim().min(1).max(5000),
    })
    .strict();

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { category, subject, message } = parsed.data;
  const userId = req.viewUserId;

  try {
    const ticket = await prisma.supportTicket.create({
      data: {
        userId,
        category,
        subject: subject || null,
        messages: {
          create: {
            authorId: userId,
            body: message,
            isStaff: false,
          },
        },
      },
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ ok: true, ticket });
  } catch (e) {
    console.error("[support] create ticket error:", e);
    return res.status(500).json({ error: "Failed to create ticket" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/support/tickets
// Lists the current user's tickets (newest activity first).
// ---------------------------------------------------------------------------
router.get("/tickets", requireAuth, async (req, res) => {
  const userId = req.viewUserId;
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { body: true, createdAt: true, isStaff: true },
        },
      },
    });

    const normalized = tickets.map((t) => ({
      ...t,
      lastMessage: t.messages[0] || null,
      messages: undefined,
    }));

    return res.json({ ok: true, tickets: normalized });
  } catch (e) {
    console.error("[support] list tickets error:", e);
    return res.status(500).json({ error: "Failed to list tickets" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/support/tickets/:id
// Reads a ticket thread (user must own the ticket, unless admin).
// ---------------------------------------------------------------------------
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
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            author: { select: { id: true, name: true, role: true } },
            attachments: true,
          },
        },
      },
    });

    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (!isAdmin && ticket.userId !== viewerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json({ ok: true, ticket });
  } catch (e) {
    console.error("[support] read ticket error:", e);
    return res.status(500).json({ error: "Failed to read ticket" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/support/tickets/:id/messages
// Adds a message to a ticket (user must own the ticket, unless admin).
// ---------------------------------------------------------------------------
router.post("/tickets/:id/messages", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId)) {
    return res.status(400).json({ error: "Invalid ticket id" });
  }

  const Body = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const viewerId = req.viewUserId;
  const isAdmin = req.user?.role === "admin";

  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true, status: true },
    });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
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
      include: { author: { select: { id: true, name: true, role: true } } },
    });

    // Touch the ticket (updatedAt). If user replies to a resolved ticket, reopen it.
    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: ticket.status === "RESOLVED" && !isAdmin ? "OPEN" : undefined,
        resolvedAt: ticket.status === "RESOLVED" && !isAdmin ? null : undefined,
      },
      select: { id: true },
    });

    return res.json({ ok: true, message });
  } catch (e) {
    console.error("[support] add message error:", e);
    return res.status(500).json({ error: "Failed to add message" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/support/tickets/:id/attachments
// Upload attachment for a ticket message
// ---------------------------------------------------------------------------
router.post(
  "/tickets/:id/attachments",
  requireAuth,
  supportUpload.single("file"),
  async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const viewerId = req.viewUserId;
    const isAdmin = req.user?.role === "admin";

    // Ensure ticket exists & permission
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, userId: true },
    });

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    if (!isAdmin && ticket.userId !== viewerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Create message + attachment
    const message = await prisma.supportMessage.create({
      data: {
        ticketId,
        authorId: viewerId,
        body: "[Attachment]",
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
      include: { attachments: true },
    });

    res.json({ ok: true, message });
  }
);

// ---------------------------------------------------------------------------
// ADMIN: PATCH /api/support/admin/tickets/:id
// Update ticket status (in-progress / resolved).
// ---------------------------------------------------------------------------
router.patch(
  "/admin/tickets/:id",
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
      return res.status(400).json({ error: "Invalid payload" });
    }

    try {
      const status = parsed.data.status;
      const ticket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status,
          resolvedAt: status === "RESOLVED" ? new Date() : null,
        },
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          updatedAt: true,
        },
      });

      return res.json({ ok: true, ticket });
    } catch (e) {
      console.error("[support] admin update ticket error:", e);
      return res.status(500).json({ error: "Failed to update ticket" });
    }
  }
);

export default router;
