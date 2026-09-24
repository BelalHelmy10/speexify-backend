import os from "node:os";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import {
  acquireDistributedLock,
  renewDistributedLock,
  releaseDistributedLock,
} from "../services/distributedLockService.js";
import { processDueTeacherEarningSnapshotJobs } from "../services/teacherEarningsService.js";

export function startTeacherEarningSnapshotScheduler({
  intervalMs = 60 * 1000,
  batchSize = 50,
  lockName = "teacher-earning-snapshot-worker",
  lockLeaseMs = Math.max(intervalMs * 4, 10 * 60 * 1000),
  lockOwnerId = process.env.SCHEDULER_OWNER_ID ||
    `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`,
} = {}) {
  logger.info(
    { intervalMs, batchSize, lockName, lockLeaseMs, lockOwnerId },
    "[teacher-earnings] snapshot scheduler starting"
  );

  let inProcessTickRunning = false;

  const tick = async () => {
    if (inProcessTickRunning) {
      logger.warn("[teacher-earnings] previous snapshot tick still running");
      return;
    }

    inProcessTickRunning = true;
    const lockToken = crypto.randomUUID();
    const renewEveryMs = Math.max(10_000, Math.floor(lockLeaseMs / 3));
    let renewalHandle = null;
    let lockLost = false;
    let lock = null;

    try {
      lock = await acquireDistributedLock({
        lockName,
        ownerId: lockOwnerId,
        token: lockToken,
        leaseMs: lockLeaseMs,
      });

      if (!lock.acquired) {
        logger.debug(
          { lockName, lockOwnerId },
          "[teacher-earnings] snapshot lock held by another worker"
        );
        return;
      }

      renewalHandle = setInterval(() => {
        renewDistributedLock({
          lockName,
          ownerId: lockOwnerId,
          token: lockToken,
          leaseMs: lockLeaseMs,
        })
          .then((renewed) => {
            if (!renewed) {
              lockLost = true;
              logger.error(
                { lockName, lockOwnerId },
                "[teacher-earnings] snapshot lock renewal failed"
              );
            }
          })
          .catch((err) => {
            lockLost = true;
            logger.error(
              { err, lockName, lockOwnerId },
              "[teacher-earnings] snapshot lock renewal error"
            );
          });
      }, renewEveryMs);

      if (!lockLost) {
        const results = await processDueTeacherEarningSnapshotJobs(undefined, {
          limit: batchSize,
          workerId: lockOwnerId,
        });
        if (results.length) {
          logger.info(
            { processed: results.length },
            "[teacher-earnings] snapshot jobs processed"
          );
        }
      }
    } finally {
      if (renewalHandle) clearInterval(renewalHandle);
      if (lock?.acquired) {
        await releaseDistributedLock({
          lockName,
          ownerId: lockOwnerId,
          token: lockToken,
        });
      }
      inProcessTickRunning = false;
    }
  };

  tick().catch((err) =>
    logger.error({ err }, "[teacher-earnings] initial snapshot tick failed")
  );
  const handle = setInterval(() => {
    tick().catch((err) =>
      logger.error({ err }, "[teacher-earnings] snapshot tick failed")
    );
  }, intervalMs);

  return () => clearInterval(handle);
}
