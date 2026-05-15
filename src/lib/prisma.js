// src/lib/prisma.js
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;
const isDevelopment = process.env.NODE_ENV === "development";
const queryLoggingFlag = String(process.env.PRISMA_LOG_QUERIES || "")
  .trim()
  .toLowerCase();
const shouldLogQueries =
  isDevelopment && ["1", "true", "yes", "on"].includes(queryLoggingFlag);
const prismaLogLevels = shouldLogQueries
  ? ["query", "error", "warn"]
  : ["error", "warn"];

const prismaClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: prismaLogLevels,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prismaClient;
}

export const prisma = prismaClient;
