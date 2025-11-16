// middleware/auth-helpers.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

export async function requireAuth(req, res, next) {
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
    console.error("[auth-helpers] requireAuth error:", e);
    return res.status(500).json({ error: "Auth check failed" });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}
