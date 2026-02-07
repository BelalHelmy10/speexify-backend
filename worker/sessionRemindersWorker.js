import "dotenv/config";
import { logger } from "../src/lib/logger.js";
import { startSessionReminderScheduler } from "../src/jobs/sessionReminders.js";

const intervalMs = Number(process.env.REMINDER_INTERVAL_MS || 5 * 60 * 1000);
const windowMinutes = Number(process.env.REMINDER_WINDOW_MINUTES || 6);
const lockName = process.env.REMINDER_LOCK_NAME || "session-reminders-scheduler";
const lockLeaseMs = Number(
  process.env.REMINDER_LOCK_LEASE_MS || Math.max(intervalMs * 4, 10 * 60 * 1000)
);

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("REMINDER_INTERVAL_MS must be a positive number");
}

if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
  throw new Error("REMINDER_WINDOW_MINUTES must be a positive number");
}

if (!Number.isFinite(lockLeaseMs) || lockLeaseMs <= 0) {
  throw new Error("REMINDER_LOCK_LEASE_MS must be a positive number");
}

logger.info(
  { intervalMs, windowMinutes, lockName, lockLeaseMs },
  "[worker:session-reminders] starting"
);

const stop = startSessionReminderScheduler({
  intervalMs,
  windowMinutes,
  lockName,
  lockLeaseMs,
});

const shutdown = (signal) => {
  logger.info({ signal }, "[worker:session-reminders] stopping");
  try {
    stop();
  } catch (err) {
    logger.error({ err }, "[worker:session-reminders] stop failed");
  }
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
