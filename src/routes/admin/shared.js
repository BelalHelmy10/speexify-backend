import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

export const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

export const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

export async function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    await prisma.audit.create({
      data: { actorId, action, entity, entityId, meta },
    });
  } catch (err) {
    logger.error({ err }, "admin audit failed");
  }
}
