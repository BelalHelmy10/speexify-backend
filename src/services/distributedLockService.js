// src/services/distributedLockService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

let ensureTablePromise = null;

async function ensureLockTable() {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS distributed_job_locks (
        lock_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        token TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        renewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS distributed_job_locks_expires_at_idx
      ON distributed_job_locks(expires_at)
    `);
  })();

  try {
    await ensureTablePromise;
  } catch (err) {
    ensureTablePromise = null;
    throw err;
  }
}

function normalizeLockName(lockName) {
  return String(lockName || "").trim().slice(0, 120);
}

function normalizeOwnerId(ownerId) {
  return String(ownerId || "").trim().slice(0, 120);
}

export async function acquireDistributedLock({
  lockName,
  ownerId,
  token,
  leaseMs = 10 * 60 * 1000,
}) {
  await ensureLockTable();

  const normalizedLockName = normalizeLockName(lockName);
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const normalizedToken = String(token || "").trim().slice(0, 160);

  if (!normalizedLockName || !normalizedOwnerId || !normalizedToken) {
    throw new Error("acquireDistributedLock: lockName, ownerId, token are required");
  }

  const lease = Number(leaseMs);
  if (!Number.isFinite(lease) || lease <= 0) {
    throw new Error("acquireDistributedLock: leaseMs must be positive");
  }

  const expiresAt = new Date(Date.now() + lease);

  const rows = await prisma.$queryRaw`
    INSERT INTO distributed_job_locks (
      lock_name,
      owner_id,
      token,
      acquired_at,
      renewed_at,
      expires_at,
      updated_at
    )
    VALUES (
      ${normalizedLockName},
      ${normalizedOwnerId},
      ${normalizedToken},
      NOW(),
      NOW(),
      ${expiresAt},
      NOW()
    )
    ON CONFLICT (lock_name) DO UPDATE
    SET owner_id = ${normalizedOwnerId},
        token = ${normalizedToken},
        acquired_at = NOW(),
        renewed_at = NOW(),
        expires_at = ${expiresAt},
        updated_at = NOW()
    WHERE distributed_job_locks.expires_at <= NOW()
    RETURNING lock_name, owner_id, token, expires_at
  `;

  if (!rows.length) {
    return { acquired: false };
  }

  return {
    acquired: true,
    lockName: normalizedLockName,
    ownerId: normalizedOwnerId,
    token: normalizedToken,
    expiresAt: rows[0].expires_at,
  };
}

export async function renewDistributedLock({
  lockName,
  ownerId,
  token,
  leaseMs = 10 * 60 * 1000,
}) {
  await ensureLockTable();

  const normalizedLockName = normalizeLockName(lockName);
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const normalizedToken = String(token || "").trim().slice(0, 160);

  const lease = Number(leaseMs);
  if (!Number.isFinite(lease) || lease <= 0) {
    throw new Error("renewDistributedLock: leaseMs must be positive");
  }

  const expiresAt = new Date(Date.now() + lease);

  const rows = await prisma.$queryRaw`
    UPDATE distributed_job_locks
    SET renewed_at = NOW(),
        expires_at = ${expiresAt},
        updated_at = NOW()
    WHERE lock_name = ${normalizedLockName}
      AND owner_id = ${normalizedOwnerId}
      AND token = ${normalizedToken}
      AND expires_at > NOW()
    RETURNING lock_name, expires_at
  `;

  return rows.length > 0;
}

export async function releaseDistributedLock({ lockName, ownerId, token }) {
  await ensureLockTable();

  const normalizedLockName = normalizeLockName(lockName);
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const normalizedToken = String(token || "").trim().slice(0, 160);

  try {
    const rows = await prisma.$queryRaw`
      DELETE FROM distributed_job_locks
      WHERE lock_name = ${normalizedLockName}
        AND owner_id = ${normalizedOwnerId}
        AND token = ${normalizedToken}
      RETURNING lock_name
    `;

    return rows.length > 0;
  } catch (err) {
    logger.error(
      { err, lockName: normalizedLockName, ownerId: normalizedOwnerId },
      "Failed to release distributed lock"
    );
    return false;
  }
}

