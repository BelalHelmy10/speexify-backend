// src/lib/prisma.js
import { PrismaClient } from "@prisma/client";

/* 👇 ADD THIS BLOCK */
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  console.log("[PRISMA BOOT] DATABASE_URL →", u.hostname, "port:", u.port);
} else {
  console.log("[PRISMA BOOT] DATABASE_URL is MISSING");
}
/* 👆 END ADD */

const globalForPrisma = globalThis;

// Log a bit more in dev, only problems in prod
const prismaClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"] // Removed "query"
        : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prismaClient;
}

export const prisma = prismaClient;
