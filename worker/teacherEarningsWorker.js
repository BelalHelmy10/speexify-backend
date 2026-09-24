import "dotenv/config";
import { logger } from "../src/lib/logger.js";
import { startTeacherEarningSnapshotScheduler } from "../src/jobs/teacherEarningsSnapshots.js";

const intervalMs = Number(process.env.TEACHER_EARNINGS_INTERVAL_MS || 60 * 1000);
const batchSize = Number(process.env.TEACHER_EARNINGS_BATCH_SIZE || 50);
const lockName =
  process.env.TEACHER_EARNINGS_LOCK_NAME || "teacher-earning-snapshot-worker";
const lockLeaseMs = Number(
  process.env.TEACHER_EARNINGS_LOCK_LEASE_MS || Math.max(intervalMs * 4, 10 * 60 * 1000)
);

if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("TEACHER_EARNINGS_INTERVAL_MS must be a positive number");
}
if (!Number.isFinite(batchSize) || batchSize <= 0) {
  throw new Error("TEACHER_EARNINGS_BATCH_SIZE must be a positive number");
}
if (!Number.isFinite(lockLeaseMs) || lockLeaseMs <= 0) {
  throw new Error("TEACHER_EARNINGS_LOCK_LEASE_MS must be a positive number");
}

logger.info(
  { intervalMs, batchSize, lockName, lockLeaseMs },
  "[worker:teacher-earnings] starting"
);

const stop = startTeacherEarningSnapshotScheduler({
  intervalMs,
  batchSize,
  lockName,
  lockLeaseMs,
});

const shutdown = (signal) => {
  logger.info({ signal }, "[worker:teacher-earnings] stopping");
  try {
    stop();
  } catch (err) {
    logger.error({ err }, "[worker:teacher-earnings] stop failed");
  }
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
