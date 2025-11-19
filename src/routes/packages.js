// api/routes/packages.js
import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

/* Shared user shape for auth checks (matches app.js) */
const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  timezone: true,
  isDisabled: true,
  rateHourlyCents: true,
  ratePerSessionCents: true,
};

/* ------------------------------------------------------------------ */
/*  Auth helpers (local copy, same behavior as in app.js)             */
/* ------------------------------------------------------------------ */
async function requireAuth(req, res, next) {
  const sessionUser = req.session.user;
  if (!sessionUser) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: sessionUser.id },
      select: publicUserSelect,
    });

    if (!dbUser || dbUser.isDisabled) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Account disabled" });
    }

    req.user = dbUser;
    req.viewUserId = req.session.asUserId || dbUser.id;
    next();
  } catch (e) {
    logger.error({ err: e }, "[packages] requireAuth error");
    return res.status(500).json({ error: "Auth check failed" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

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
router.post("/admin/packages", requireAuth, requireAdmin, async (req, res) => {
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

    if (!title) return res.status(400).json({ error: "title is required" });
    if (!["INDIVIDUAL", "CORPORATE"].includes(audience)) {
      return res
        .status(400)
        .json({ error: "audience must be INDIVIDUAL or CORPORATE" });
    }
    if (!["PER_SESSION", "BUNDLE", "CUSTOM"].includes(priceType)) {
      return res.status(400).json({ error: "priceType invalid" });
    }

    const created = await prisma.package.create({
      data: {
        title,
        description: description || null,
        audience,
        priceType,
        priceUSD: priceUSD !== null ? Number(priceUSD) : null,
        startingAtUSD: startingAtUSD !== null ? Number(startingAtUSD) : null,
        sessionsPerPack:
          sessionsPerPack !== null ? Number(sessionsPerPack) : null,
        durationMin: durationMin !== null ? Number(durationMin) : null,
        isPopular: !!isPopular,
        active: !!active,
        sortOrder: Number(sortOrder || 0),
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
  async (req, res) => {
    try {
      const id = Number(req.params.id);
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

      if (data.priceUSD !== undefined) {
        data.priceUSD = data.priceUSD === null ? null : Number(data.priceUSD);
      }
      if (data.startingAtUSD !== undefined) {
        data.startingAtUSD =
          data.startingAtUSD === null ? null : Number(data.startingAtUSD);
      }
      if (data.sessionsPerPack !== undefined) {
        data.sessionsPerPack =
          data.sessionsPerPack === null ? null : Number(data.sessionsPerPack);
      }
      if (data.durationMin !== undefined) {
        data.durationMin =
          data.durationMin === null ? null : Number(data.durationMin);
      }
      if (data.sortOrder !== undefined) data.sortOrder = Number(data.sortOrder);
      if (data.isPopular !== undefined) data.isPopular = !!data.isPopular;
      if (data.active !== undefined) data.active = !!data.active;

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
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.package.delete({ where: { id } });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err: err }, "[packages] admin delete error");
      res.status(500).json({ error: "Failed to delete package" });
    }
  }
);

export default router;
