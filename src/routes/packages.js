// api/routes/packages.js
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";

const router = Router();

const PackageIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const nullableText = (max) => z.string().trim().max(max).nullable().optional();
const nullableNumber = z.coerce.number().finite().nonnegative().nullable().optional();
const booleanLike = z.preprocess(
  (value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  },
  z.boolean()
);

const PackageAudienceSchema = z.enum(["INDIVIDUAL", "CORPORATE"]);
const PackagePriceTypeSchema = z.enum(["PER_SESSION", "BUNDLE", "CUSTOM"]);

const PackageBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: nullableText(1000),
    audience: PackageAudienceSchema.default("INDIVIDUAL"),
    priceType: PackagePriceTypeSchema.default("BUNDLE"),
    priceUSD: nullableNumber.default(null),
    startingAtUSD: nullableNumber.default(null),
    sessionsPerPack: z.coerce.number().int().positive().nullable().optional().default(null),
    durationMin: z.coerce.number().int().positive().nullable().optional().default(null),
    isPopular: booleanLike.default(false),
    active: booleanLike.default(true),
    sortOrder: z.coerce.number().int().default(0),
    image: nullableText(300),
    features: z.string().max(5000).optional().default(""),
  })
  .strict();

const PackagePatchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: nullableText(1000),
    audience: PackageAudienceSchema.optional(),
    priceType: PackagePriceTypeSchema.optional(),
    priceUSD: nullableNumber,
    startingAtUSD: nullableNumber,
    sessionsPerPack: z.coerce.number().int().positive().nullable().optional(),
    durationMin: z.coerce.number().int().positive().nullable().optional(),
    isPopular: booleanLike.optional(),
    active: booleanLike.optional(),
    sortOrder: z.coerce.number().int().optional(),
    image: nullableText(300),
    features: z.string().max(5000).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one package field is required",
  });

/* ------------------------------------------------------------------ */
/*  PUBLIC: /api/packages                                             */
/* ------------------------------------------------------------------ */

// GET /api/packages
router.get("/packages", async (req, res) => {
  try {
    const aud = String(req.query?.audience || "").toUpperCase();
    const where = { active: true };
    if (aud === "INDIVIDUAL" || aud === "CORPORATE") where.audience = aud;

    const packages = await prisma.package.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { priceUSD: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        priceUSD: true,
        startingAtUSD: true,
        priceType: true,
        audience: true,
        isPopular: true,
        active: true,
        sortOrder: true,
        sessionsPerPack: true,
        durationMin: true,
        image: true,
        features: true,
      },
    });

    const mapped = packages.map((p) => ({ ...p, featuresRaw: p.features }));
    res.json(mapped);
  } catch (error) {
    logger.error({ err: error }, "[packages] list error");
    res.status(500).json({ error: "Failed to fetch packages" });
  }
});

/* ------------------------------------------------------------------ */
/*  ADMIN: /api/admin/packages...                                     */
/* ------------------------------------------------------------------ */

// GET /api/admin/packages
router.get("/admin/packages", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience = "", q = "", active = "" } = req.query;
    const where = {};

    if (audience === "INDIVIDUAL" || audience === "CORPORATE") {
      where.audience = audience;
    }
    if (active === "true") where.active = true;
    if (active === "false") where.active = false;

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { features: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.package.findMany({
      where,
      orderBy: [{ audience: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });

    res.json(items);
  } catch (err) {
    logger.error({ err: err }, "[packages] admin list error");
    res.status(500).json({ error: "Failed to load packages" });
  }
});

// POST /api/admin/packages
router.post(
  "/admin/packages",
  requireAuth,
  requireAdmin,
  validateRequest({ body: PackageBodySchema }),
  async (req, res) => {
  try {
    const {
      title,
      description,
      audience = "INDIVIDUAL",
      priceType = "BUNDLE",
      priceUSD = null,
      startingAtUSD = null,
      sessionsPerPack = null,
      durationMin = null,
      isPopular = false,
      active = true,
      sortOrder = 0,
      image = null,
      features = "",
    } = req.body;

    const created = await prisma.package.create({
      data: {
        title,
        description: description || null,
        audience,
        priceType,
        priceUSD,
        startingAtUSD,
        sessionsPerPack,
        durationMin,
        isPopular,
        active,
        sortOrder,
        image: image || null,
        features: features || "",
      },
    });

    res.status(201).json(created);
  } catch (err) {
    logger.error({ err: err }, "[packages] admin create error");
    res.status(500).json({ error: "Failed to create package" });
  }
});

// PATCH /api/admin/packages/:id
router.patch(
  "/admin/packages/:id",
  requireAuth,
  requireAdmin,
  validateRequest({ params: PackageIdParamsSchema, body: PackagePatchBodySchema }),
  async (req, res) => {
    try {
      const id = req.params.id;
      const data = {};
      const fields = [
        "title",
        "description",
        "audience",
        "priceType",
        "image",
        "features",
        "isPopular",
        "active",
        "sortOrder",
        "sessionsPerPack",
        "durationMin",
        "priceUSD",
        "startingAtUSD",
      ];
      for (const k of fields) {
        if (req.body[k] !== undefined) data[k] = req.body[k];
      }

      const updated = await prisma.package.update({ where: { id }, data });
      res.json(updated);
    } catch (err) {
      logger.error({ err: err }, "[packages] admin update error");
      res.status(500).json({ error: "Failed to update package" });
    }
  }
);

// DELETE /api/admin/packages/:id
router.delete(
  "/admin/packages/:id",
  requireAuth,
  requireAdmin,
  validateRequest({ params: PackageIdParamsSchema }),
  async (req, res) => {
    try {
      const id = req.params.id;
      await prisma.package.delete({ where: { id } });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err: err }, "[packages] admin delete error");
      res.status(500).json({ error: "Failed to delete package" });
    }
  }
);

export default router;
