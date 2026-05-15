import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_POLICY_VERSION,
  PRIVACY_RETENTION_DAYS_AUDITS,
  PRIVACY_RETENTION_DAYS_NOTIFICATIONS,
  PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS,
  PRIVACY_RETENTION_DAYS_VERIFICATION_CODES,
} from "../config/env.js";

export const PRIVACY_REQUEST_TYPES = Object.freeze({
  EXPORT: "EXPORT",
  DELETE: "DELETE",
});

export const PRIVACY_REQUEST_STATUSES = Object.freeze({
  PENDING: "PENDING",
  IN_REVIEW: "IN_REVIEW",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
});

const FINAL_PRIVACY_STATUSES = new Set([
  PRIVACY_REQUEST_STATUSES.COMPLETED,
  PRIVACY_REQUEST_STATUSES.REJECTED,
]);
const PRIVACY_REDACTED_EMAIL_DOMAIN = "deleted.speexify.local";
const PRIVACY_REDACTED_TEXT = "[removed by privacy request]";

let ensurePrivacyTablePromise = null;

export function normalizePrivacyRequestType(raw, fallback = PRIVACY_REQUEST_TYPES.DELETE) {
  const normalized = String(raw || "")
    .trim()
    .toUpperCase();
  if (normalized === PRIVACY_REQUEST_TYPES.EXPORT) return PRIVACY_REQUEST_TYPES.EXPORT;
  if (normalized === PRIVACY_REQUEST_TYPES.DELETE) return PRIVACY_REQUEST_TYPES.DELETE;
  return fallback;
}

export function normalizePrivacyRequestStatus(
  raw,
  fallback = PRIVACY_REQUEST_STATUSES.PENDING
) {
  const normalized = String(raw || "")
    .trim()
    .toUpperCase();

  if (normalized === PRIVACY_REQUEST_STATUSES.PENDING) return PRIVACY_REQUEST_STATUSES.PENDING;
  if (normalized === PRIVACY_REQUEST_STATUSES.IN_REVIEW) return PRIVACY_REQUEST_STATUSES.IN_REVIEW;
  if (normalized === PRIVACY_REQUEST_STATUSES.COMPLETED) return PRIVACY_REQUEST_STATUSES.COMPLETED;
  if (normalized === PRIVACY_REQUEST_STATUSES.REJECTED) return PRIVACY_REQUEST_STATUSES.REJECTED;
  return fallback;
}

function normalizeLimit(limit, fallback = 50) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.floor(parsed));
}

function mapPrivacyRequestRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    userEmail: row.user_email,
    requestType: row.request_type,
    status: row.status,
    reason: row.reason || null,
    notes: row.notes || null,
    requestedAt: row.requested_at,
    processedAt: row.processed_at || null,
    requestedByAdminId:
      row.requested_by_admin_id == null ? null : Number(row.requested_by_admin_id),
    processedByAdminId:
      row.processed_by_admin_id == null ? null : Number(row.processed_by_admin_id),
  };
}

function isRedactedEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .endsWith(`@${PRIVACY_REDACTED_EMAIL_DOMAIN}`);
}

function buildRedactedEmail(userId) {
  const suffix = crypto.randomBytes(8).toString("hex");
  return `deleted-user-${userId}-${suffix}@${PRIVACY_REDACTED_EMAIL_DOMAIN}`;
}

async function ensurePrivacyRequestTable() {
  if (ensurePrivacyTablePromise) return ensurePrivacyTablePromise;

  ensurePrivacyTablePromise = (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS privacy_requests (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        request_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        reason TEXT,
        notes TEXT,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        requested_by_admin_id INTEGER,
        processed_by_admin_id INTEGER
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS privacy_requests_user_requested_at_idx
      ON privacy_requests(user_id, requested_at DESC)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS privacy_requests_status_requested_at_idx
      ON privacy_requests(status, requested_at DESC)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_pending_unique_idx
      ON privacy_requests(user_id, request_type)
      WHERE status IN ('PENDING', 'IN_REVIEW')
    `);
  })();

  try {
    await ensurePrivacyTablePromise;
  } catch (err) {
    ensurePrivacyTablePromise = null;
    throw err;
  }
}

function buildListRequestsQuery({ userId, status, type, limit }) {
  const clauses = [];
  const values = [];

  if (userId != null) {
    values.push(Number(userId));
    clauses.push(`user_id = $${values.length}`);
  }

  if (status) {
    values.push(normalizePrivacyRequestStatus(status, status));
    clauses.push(`status = $${values.length}`);
  }

  if (type) {
    values.push(normalizePrivacyRequestType(type, type));
    clauses.push(`request_type = $${values.length}`);
  }

  values.push(normalizeLimit(limit));
  const limitPlaceholder = `$${values.length}`;

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT
      id,
      user_id,
      user_email,
      request_type,
      status,
      reason,
      notes,
      requested_at,
      processed_at,
      requested_by_admin_id,
      processed_by_admin_id
    FROM privacy_requests
    ${whereClause}
    ORDER BY requested_at DESC
    LIMIT ${limitPlaceholder}
  `;

  return { sql, values };
}

export async function listPrivacyRequests({ userId = null, status = "", type = "", limit = 50 } = {}) {
  await ensurePrivacyRequestTable();

  const { sql, values } = buildListRequestsQuery({ userId, status, type, limit });
  const rows = await prisma.$queryRawUnsafe(sql, ...values);
  return rows.map((row) => mapPrivacyRequestRow(row));
}

export async function getPrivacyRequestById(requestId) {
  await ensurePrivacyRequestTable();

  const rid = Number(requestId);
  if (!Number.isInteger(rid) || rid <= 0) return null;

  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT
        id,
        user_id,
        user_email,
        request_type,
        status,
        reason,
        notes,
        requested_at,
        processed_at,
        requested_by_admin_id,
        processed_by_admin_id
      FROM privacy_requests
      WHERE id = $1
      LIMIT 1
    `,
    rid
  );

  if (!rows.length) return null;
  return mapPrivacyRequestRow(rows[0]);
}

export async function createPrivacyRequest({
  userId,
  userEmail,
  type = PRIVACY_REQUEST_TYPES.DELETE,
  reason = null,
  status = PRIVACY_REQUEST_STATUSES.PENDING,
  requestedByAdminId = null,
} = {}) {
  await ensurePrivacyRequestTable();

  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("createPrivacyRequest: valid userId is required");
  }

  const normalizedType = normalizePrivacyRequestType(type);
  const normalizedStatus = normalizePrivacyRequestStatus(status);
  const normalizedEmail = String(userEmail || "").trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("createPrivacyRequest: userEmail is required");
  }

  const existingPendingRows = await prisma.$queryRawUnsafe(
    `
      SELECT
        id,
        user_id,
        user_email,
        request_type,
        status,
        reason,
        notes,
        requested_at,
        processed_at,
        requested_by_admin_id,
        processed_by_admin_id
      FROM privacy_requests
      WHERE user_id = $1
        AND request_type = $2
        AND status IN ('PENDING', 'IN_REVIEW')
      ORDER BY requested_at DESC
      LIMIT 1
    `,
    uid,
    normalizedType
  );

  if (existingPendingRows.length && !FINAL_PRIVACY_STATUSES.has(normalizedStatus)) {
    return { created: false, request: mapPrivacyRequestRow(existingPendingRows[0]) };
  }

  const isFinal = FINAL_PRIVACY_STATUSES.has(normalizedStatus);
  const rows = await prisma.$queryRawUnsafe(
    `
      INSERT INTO privacy_requests (
        user_id,
        user_email,
        request_type,
        status,
        reason,
        requested_by_admin_id,
        processed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, ${isFinal ? "NOW()" : "NULL"})
      RETURNING
        id,
        user_id,
        user_email,
        request_type,
        status,
        reason,
        notes,
        requested_at,
        processed_at,
        requested_by_admin_id,
        processed_by_admin_id
    `,
    uid,
    normalizedEmail,
    normalizedType,
    normalizedStatus,
    reason ? String(reason).slice(0, 2000) : null,
    requestedByAdminId == null ? null : Number(requestedByAdminId)
  );

  return { created: true, request: mapPrivacyRequestRow(rows[0]) };
}

export async function updatePrivacyRequestStatus({
  requestId,
  status,
  notes = null,
  processedByAdminId,
}) {
  await ensurePrivacyRequestTable();

  const normalizedStatus = normalizePrivacyRequestStatus(status);
  const isFinal = FINAL_PRIVACY_STATUSES.has(normalizedStatus);
  const rid = Number(requestId);
  const adminId = Number(processedByAdminId);

  const rows = await prisma.$queryRawUnsafe(
    `
      UPDATE privacy_requests
      SET
        status = $1,
        notes = COALESCE($2, notes),
        processed_by_admin_id = $3,
        processed_at = CASE WHEN $4::boolean THEN NOW() ELSE processed_at END
      WHERE id = $5
      RETURNING
        id,
        user_id,
        user_email,
        request_type,
        status,
        reason,
        notes,
        requested_at,
        processed_at,
        requested_by_admin_id,
        processed_by_admin_id
    `,
    normalizedStatus,
    notes ? String(notes).slice(0, 2000) : null,
    Number.isInteger(adminId) ? adminId : null,
    isFinal,
    rid
  );

  if (!rows.length) return null;
  return mapPrivacyRequestRow(rows[0]);
}

export async function anonymizeUserForPrivacyDeletion({ userId }) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("anonymizeUserForPrivacyDeletion: valid userId is required");
  }

  const randomPasswordHash = await bcrypt.hash(
    crypto.randomBytes(32).toString("hex"),
    10
  );

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: uid },
      select: {
        id: true,
        email: true,
        isDisabled: true,
      },
    });

    if (!user) {
      return {
        processed: false,
        reason: "USER_NOT_FOUND",
      };
    }

    const alreadyRedacted = isRedactedEmail(user.email);
    const previousEmail = String(user.email || "")
      .trim()
      .toLowerCase();
    const nextEmail = alreadyRedacted ? previousEmail : buildRedactedEmail(uid);

    await tx.user.update({
      where: { id: uid },
      data: {
        email: nextEmail,
        name: null,
        timezone: null,
        isDisabled: true,
        hashedPassword: randomPasswordHash,
      },
    });

    const [
      verificationCodesDeleted,
      passwordResetCodesDeleted,
      notificationsDeleted,
      availabilityDeleted,
      onboardingFormsSanitized,
      assessmentsSanitized,
      assessmentReviewsUnassigned,
      supportMessagesSanitized,
      supportTicketsSanitized,
      supportInternalNotesSanitized,
    ] = await Promise.all([
      alreadyRedacted
        ? Promise.resolve({ count: 0 })
        : tx.verificationCode.deleteMany({
            where: { email: previousEmail },
          }),
      alreadyRedacted
        ? Promise.resolve({ count: 0 })
        : tx.passwordResetCode.deleteMany({
            where: { email: previousEmail },
          }),
      tx.notification.deleteMany({
        where: { userId: uid },
      }),
      tx.availability.deleteMany({
        where: { userId: uid },
      }),
      tx.onboardingForm.updateMany({
        where: { userId: uid },
        data: { answers: {} },
      }),
      tx.assessmentSubmission.updateMany({
        where: { userId: uid },
        data: {
          text: PRIVACY_REDACTED_TEXT,
          feedback: null,
          reviewMeta: null,
        },
      }),
      tx.assessmentSubmission.updateMany({
        where: { reviewedById: uid },
        data: {
          reviewedById: null,
        },
      }),
      tx.supportMessage.updateMany({
        where: { authorId: uid },
        data: {
          body: PRIVACY_REDACTED_TEXT,
        },
      }),
      tx.supportTicket.updateMany({
        where: { userId: uid },
        data: {
          subject: null,
        },
      }),
      tx.supportInternalNote.updateMany({
        where: { authorId: uid },
        data: {
          body: PRIVACY_REDACTED_TEXT,
        },
      }),
    ]);

    return {
      processed: true,
      userId: uid,
      alreadyRedacted,
      redactedEmail: nextEmail,
      wasDisabled: Boolean(user.isDisabled),
      counters: {
        verificationCodesDeleted: verificationCodesDeleted.count,
        passwordResetCodesDeleted: passwordResetCodesDeleted.count,
        notificationsDeleted: notificationsDeleted.count,
        availabilityDeleted: availabilityDeleted.count,
        onboardingFormsSanitized: onboardingFormsSanitized.count,
        assessmentsSanitized: assessmentsSanitized.count,
        assessmentReviewsUnassigned: assessmentReviewsUnassigned.count,
        supportMessagesSanitized: supportMessagesSanitized.count,
        supportTicketsSanitized: supportTicketsSanitized.count,
        supportInternalNotesSanitized: supportInternalNotesSanitized.count,
      },
    };
  });
}

export async function buildUserPrivacyExport(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("buildUserPrivacyExport: valid userId is required");
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      timezone: true,
      createdAt: true,
      updatedAt: true,
      isDisabled: true,
    },
  });

  if (!user) {
    const err = new Error("User not found");
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const [
    userPackages,
    orders,
    sessionsAsLearner,
    sessionsAsTeacher,
    notifications,
    onboardingForms,
    assessments,
    supportTickets,
    supportMessages,
  ] = await Promise.all([
    prisma.userPackage.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
    }),
    prisma.order.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        amountCents: true,
        currency: true,
        status: true,
        psp: true,
        createdAt: true,
        updatedAt: true,
        packageId: true,
      },
    }),
    prisma.session.findMany({
      where: {
        OR: [{ userId: uid }, { participants: { some: { userId: uid } } }],
      },
      orderBy: { startAt: "desc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        status: true,
        type: true,
        teacherId: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        participants: {
          select: {
            userId: true,
            status: true,
            attendedAt: true,
          },
        },
      },
    }),
    prisma.session.findMany({
      where: { teacherId: uid },
      orderBy: { startAt: "desc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        status: true,
        type: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.notification.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
      take: 5000,
    }),
    prisma.onboardingForm.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
    }),
    prisma.assessmentSubmission.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        text: true,
        wordCount: true,
        status: true,
        score: true,
        cefr: true,
        feedback: true,
        reviewMeta: true,
        reviewedAt: true,
        reviewedById: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.supportTicket.findMany({
      where: { userId: uid },
      orderBy: { updatedAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            attachments: true,
          },
        },
      },
    }),
    prisma.supportMessage.findMany({
      where: { authorId: uid },
      orderBy: { createdAt: "desc" },
      include: {
        attachments: true,
      },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    policyVersion: PRIVACY_POLICY_VERSION,
    contactEmail: PRIVACY_CONTACT_EMAIL,
    user,
    datasets: {
      userPackages,
      orders,
      sessionsAsLearner,
      sessionsAsTeacher,
      notifications,
      onboardingForms,
      assessments,
      supportTickets,
      supportMessages,
    },
  };
}

export function getPrivacyPolicySummary() {
  return {
    policyVersion: PRIVACY_POLICY_VERSION,
    contactEmail: PRIVACY_CONTACT_EMAIL,
    rights: [
      "access",
      "rectification",
      "erasure_request",
      "processing_restriction_request",
    ],
    retentionDays: {
      verificationCodes: PRIVACY_RETENTION_DAYS_VERIFICATION_CODES,
      notifications: PRIVACY_RETENTION_DAYS_NOTIFICATIONS,
      audits: PRIVACY_RETENTION_DAYS_AUDITS,
      supportTickets: PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS,
    },
  };
}

export async function logPrivacyExportEvent({ userId, userEmail, requestedByAdminId = null }) {
  try {
    await createPrivacyRequest({
      userId,
      userEmail,
      type: PRIVACY_REQUEST_TYPES.EXPORT,
      status: PRIVACY_REQUEST_STATUSES.COMPLETED,
      requestedByAdminId,
      reason: requestedByAdminId
        ? "admin_export_generated"
        : "self_service_export_generated",
    });
  } catch (err) {
    logger.warn(
      { err, userId: Number(userId) },
      "[privacy] failed to log export event"
    );
  }
}
