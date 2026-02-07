import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { logger } from "../src/lib/logger.js";
import {
  PRIVACY_RETENTION_DAYS_AUDITS,
  PRIVACY_RETENTION_DAYS_NOTIFICATIONS,
  PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS,
  PRIVACY_RETENTION_DAYS_VERIFICATION_CODES,
} from "../src/config/env.js";

const shouldApply = process.argv.includes("--apply");

function buildCutoff(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function printSummary(summary) {
  const lines = [
    `mode: ${summary.mode}`,
    `cutoffs.verificationCodes: ${summary.cutoffs.verificationCodes}`,
    `cutoffs.notifications: ${summary.cutoffs.notifications}`,
    `cutoffs.audits: ${summary.cutoffs.audits}`,
    `cutoffs.supportTickets: ${summary.cutoffs.supportTickets}`,
    `verificationCodes: ${summary.counters.verificationCodes}`,
    `passwordResetCodes: ${summary.counters.passwordResetCodes}`,
    `notifications: ${summary.counters.notifications}`,
    `audits: ${summary.counters.audits}`,
    `supportTickets: ${summary.counters.supportTickets}`,
  ];

  logger.info({ summary }, "[privacy] retention cleanup summary");
  console.log(lines.join("\n"));
}

async function run() {
  const cutoffs = {
    verificationCodes: buildCutoff(PRIVACY_RETENTION_DAYS_VERIFICATION_CODES),
    notifications: buildCutoff(PRIVACY_RETENTION_DAYS_NOTIFICATIONS),
    audits: buildCutoff(PRIVACY_RETENTION_DAYS_AUDITS),
    supportTickets: buildCutoff(PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS),
  };

  const whereClauses = {
    verificationCodes: { updatedAt: { lt: cutoffs.verificationCodes } },
    passwordResetCodes: { updatedAt: { lt: cutoffs.verificationCodes } },
    notifications: {
      createdAt: { lt: cutoffs.notifications },
      readAt: { not: null },
    },
    audits: { createdAt: { lt: cutoffs.audits } },
    supportTickets: {
      status: "RESOLVED",
      updatedAt: { lt: cutoffs.supportTickets },
    },
  };

  const mode = shouldApply ? "apply" : "dry-run";

  const counters = shouldApply
    ? await prisma.$transaction(async (tx) => {
        const [
          verificationCodes,
          passwordResetCodes,
          notifications,
          audits,
          supportTickets,
        ] = await Promise.all([
          tx.verificationCode.deleteMany({ where: whereClauses.verificationCodes }),
          tx.passwordResetCode.deleteMany({ where: whereClauses.passwordResetCodes }),
          tx.notification.deleteMany({ where: whereClauses.notifications }),
          tx.audit.deleteMany({ where: whereClauses.audits }),
          tx.supportTicket.deleteMany({ where: whereClauses.supportTickets }),
        ]);

        return {
          verificationCodes: verificationCodes.count,
          passwordResetCodes: passwordResetCodes.count,
          notifications: notifications.count,
          audits: audits.count,
          supportTickets: supportTickets.count,
        };
      })
    : {
        verificationCodes: await prisma.verificationCode.count({
          where: whereClauses.verificationCodes,
        }),
        passwordResetCodes: await prisma.passwordResetCode.count({
          where: whereClauses.passwordResetCodes,
        }),
        notifications: await prisma.notification.count({
          where: whereClauses.notifications,
        }),
        audits: await prisma.audit.count({ where: whereClauses.audits }),
        supportTickets: await prisma.supportTicket.count({
          where: whereClauses.supportTickets,
        }),
      };

  const summary = {
    mode,
    cutoffs: {
      verificationCodes: cutoffs.verificationCodes.toISOString(),
      notifications: cutoffs.notifications.toISOString(),
      audits: cutoffs.audits.toISOString(),
      supportTickets: cutoffs.supportTickets.toISOString(),
    },
    counters,
  };

  printSummary(summary);

  if (!shouldApply) {
    console.log("Dry-run only. Re-run with --apply to execute deletes.");
  }
}

run()
  .catch((err) => {
    logger.error({ err }, "[privacy] retention cleanup failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
