import "dotenv/config";
import { logger } from "../src/lib/logger.js";
import { startSessionReminderScheduler } from "../src/jobs/sessionReminders.js";

const intervalMs = Number(process.env.REMINDER_INTERVAL_MS || 5 * 60 * 1000);
const windowMinutes = Number(process.env.REMINDER_WINDOW_MINUTES || 6);

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("REMINDER_INTERVAL_MS must be a positive number");
}

if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
  throw new Error("REMINDER_WINDOW_MINUTES must be a positive number");
}

logger.info(
  { intervalMs, windowMinutes },
  "[worker:session-reminders] starting"
);

const stop = startSessionReminderScheduler({ intervalMs, windowMinutes });

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

