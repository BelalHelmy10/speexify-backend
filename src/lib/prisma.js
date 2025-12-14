// src/lib/prisma.js
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

// Log a bit more in dev, only problems in prod
const prismaClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prismaClient;
}

export const prisma = prismaClient;
