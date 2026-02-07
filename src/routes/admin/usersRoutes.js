import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { validateRequest } from "../../middleware/validateRequest.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../services/emailService.js";
import { audit, genCode, hashCode } from "./shared.js";

const router = Router();

const RoleSchema = z.enum(["learner", "teacher", "admin"]);
const UserIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const UsersListQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  role: z.union([RoleSchema, z.literal("")]).optional().default(""),
});

const CreateUserBodySchema = z
  .object({
    email: z.preprocess(
      (value) =>
        typeof value === "string" ? value.toLowerCase().trim() : value,
      z.string().email()
    ),
    name: z.string().trim().max(120).optional().default(""),
    role: RoleSchema.optional().default("learner"),
    timezone: z.string().trim().max(80).nullable().optional().default(null),
  })
  .strict();

const RateCentsSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
  z.literal(""),
  z.null(),
]);

const PatchUserBodySchema = z
  .object({
    role: RoleSchema.optional(),
    isDisabled: z.boolean().optional(),
    name: z.string().trim().max(120).nullable().optional(),
    timezone: z.string().trim().max(80).nullable().optional(),
    rateHourlyCents: RateCentsSchema.optional(),
    ratePerSessionCents: RateCentsSchema.optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field must be provided",
  });

router.get(
  "/admin/users",
  requireAuth,
  requireAdmin,
  validateRequest({ query: UsersListQuerySchema }),
  async (req, res, next) => {
    try {
      const { q, role } = req.query;
      const where = {};

      if (q) {
        where.OR = [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ];
      }
      if (role) where.role = String(role);

      const users = await prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
          createdAt: true,
          rateHourlyCents: true,
          ratePerSessionCents: true,
        },
        orderBy: { id: "asc" },
      });

      res.json(users);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/admin/users",
  requireAuth,
  requireAdmin,
  validateRequest({ body: CreateUserBodySchema }),
  async (req, res) => {
    try {
      const { email, name, role, timezone } = req.body;

      if (!email) return res.status(400).json({ error: "email required" });

      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) return res.status(409).json({ error: "User already exists" });

      const rand = crypto.randomBytes(16).toString("hex");
      const hashedPassword = crypto
        .createHash("sha256")
        .update(rand)
        .digest("hex");

      const user = await prisma.user.create({
        data: { email, name: name || null, role, timezone, hashedPassword },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
        },
      });

      const code = genCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 10 * 60_000);

      await prisma.passwordResetCode.upsert({
        where: { email },
        update: { codeHash, expiresAt, attempts: 0 },
        create: { email, codeHash, expiresAt, attempts: 0 },
      });

      await sendEmail(
        email,
        "Welcome to Speexify — set your password",
        `<p>Hi${name ? " " + name : ""},</p>
       <p>Your setup code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>Use it on the "Forgot password" page within 10 minutes.</p>`
      );

      await audit(req.user.id, "user_create", "User", user.id, { email, role });
      res.status(201).json({ user });
    } catch (err) {
      logger.error({ err }, "admin.createUser error");
      res.status(500).json({ error: "Failed to create user" });
    }
  }
);

router.patch(
  "/admin/users/:id",
  requireAuth,
  requireAdmin,
  validateRequest({
    params: UserIdParamsSchema,
    body: PatchUserBodySchema,
  }),
  async (req, res) => {
    try {
      const id = req.params.id;
      const {
        role,
        isDisabled,
        name,
        timezone,
        rateHourlyCents,
        ratePerSessionCents,
      } = req.body;

      const before = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          role: true,
          isDisabled: true,
          rateHourlyCents: true,
          ratePerSessionCents: true,
        },
      });
      if (!before) return res.status(404).json({ error: "Not found" });

      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(role ? { role } : {}),
          ...(typeof isDisabled === "boolean" ? { isDisabled } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          ...(rateHourlyCents !== undefined
            ? {
                rateHourlyCents:
                  rateHourlyCents === null || rateHourlyCents === ""
                    ? null
                    : Number(rateHourlyCents),
              }
            : {}),
          ...(ratePerSessionCents !== undefined
            ? {
                ratePerSessionCents:
                  ratePerSessionCents === null || ratePerSessionCents === ""
                    ? null
                    : Number(ratePerSessionCents),
              }
            : {}),
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
          rateHourlyCents: true,
          ratePerSessionCents: true,
        },
      });

      if (role && role !== before.role) {
        await audit(req.user.id, "role_change", "User", id, {
          from: before.role,
          to: role,
        });
      }

      if (typeof isDisabled === "boolean" && isDisabled !== before.isDisabled) {
        await audit(
          req.user.id,
          isDisabled ? "user_disable" : "user_enable",
          "User",
          id
        );
      }

      if (rateHourlyCents !== undefined || ratePerSessionCents !== undefined) {
        await audit(req.user.id, "teacher_rate_update", "User", id, {
          from: {
            rateHourlyCents: before.rateHourlyCents,
            ratePerSessionCents: before.ratePerSessionCents,
          },
          to: {
            rateHourlyCents: user.rateHourlyCents,
            ratePerSessionCents: user.ratePerSessionCents,
          },
        });
      }

      res.json(user);
    } catch (err) {
      logger.error({ err }, "admin.patchUser error");
      res.status(500).json({ error: "Failed to update user" });
    }
  }
);

router.post(
  "/admin/users/:id/reset-password",
  requireAuth,
  requireAdmin,
  validateRequest({ params: UserIdParamsSchema }),
  async (req, res) => {
    try {
      const id = req.params.id;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return res.status(404).json({ error: "Not found" });

      const code = genCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 10 * 60_000);

      await prisma.passwordResetCode.upsert({
        where: { email: user.email },
        update: { codeHash, expiresAt, attempts: 0 },
        create: { email: user.email, codeHash, expiresAt, attempts: 0 },
      });

      await sendEmail(
        user.email,
        "Reset your Speexify password",
        `<p>Hi ${user.name || ""}</p>
       <p>Your reset code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>Use it on the "Forgot password" page within 10 minutes.</p>`
      );

      await audit(req.user.id, "password_reset_send", "User", id);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "admin.resetPassword error");
      res.status(500).json({ error: "Failed to send reset" });
    }
  }
);

export default router;
