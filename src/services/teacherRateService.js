import { prisma } from "../lib/prisma.js";

function validRate(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error(`${label} must be a valid date`);
    error.code = "INVALID_RATE_DATE";
    throw error;
  }
  return date;
}

export function normalizeTeacherRate({
  rateHourlyEgpPiastres,
  ratePerSessionEgpPiastres,
} = {}) {
  return {
    rateHourlyEgpPiastres: validRate(rateHourlyEgpPiastres),
    ratePerSessionEgpPiastres: validRate(ratePerSessionEgpPiastres),
  };
}

export function selectEffectiveTeacherRate({
  history = null,
  fallback = null,
  allowFallback = false,
} = {}) {
  if (history) {
    return {
      rateHourlyEgpPiastres: history.rateHourlyEgpPiastres,
      ratePerSessionEgpPiastres: history.ratePerSessionEgpPiastres,
      effectiveFrom: history.effectiveFrom,
      source: "history",
    };
  }

  if (allowFallback && fallback) {
    const normalized = normalizeTeacherRate(fallback);
    return {
      ...normalized,
      effectiveFrom: null,
      source: "completion_current_rate",
    };
  }

  return null;
}

/**
 * Resolve only an explicitly recorded rate at the requested instant.
 * Current User fields are not used for historical backfills by default.
 */
export async function getTeacherRateAt(
  teacherId,
  asOf,
  db = prisma,
  { fallback = null, allowFallback = false } = {}
) {
  const at = validDate(asOf, "Rate lookup timestamp");
  const history = await db.teacherRateHistory.findFirst({
    where: {
      teacherId: Number(teacherId),
      effectiveFrom: { lte: at },
    },
    orderBy: { effectiveFrom: "desc" },
    select: {
      id: true,
      effectiveFrom: true,
      rateHourlyEgpPiastres: true,
      ratePerSessionEgpPiastres: true,
    },
  });

  if (history || !allowFallback) {
    return selectEffectiveTeacherRate({ history, fallback, allowFallback });
  }

  // Once any history exists, a timestamp before the first effective rate is
  // deliberately unresolved; falling back to today's User fields would
  // silently misprice an older session.
  const anyHistory = await db.teacherRateHistory.findFirst({
    where: { teacherId: Number(teacherId) },
    select: { id: true },
  });
  return selectEffectiveTeacherRate({
    history: anyHistory ? null : history,
    fallback,
    allowFallback: !anyHistory,
  });
}

/**
 * Append or replace an effective-dated admin rate without rewriting earning
 * rows. The neighboring interval end dates are maintained for audit views;
 * resolution remains based on effectiveFrom so a missing rate is explicit.
 */
export async function recordTeacherRateHistory({
  teacherId,
  effectiveFrom = new Date(),
  rateHourlyEgpPiastres,
  ratePerSessionEgpPiastres,
  createdById = null,
  db = prisma,
} = {}) {
  const effective = validDate(effectiveFrom, "Rate effective date");
  const rate = normalizeTeacherRate({
    rateHourlyEgpPiastres,
    ratePerSessionEgpPiastres,
  });
  const tid = Number(teacherId);

  const next = await db.teacherRateHistory.findFirst({
    where: { teacherId: tid, effectiveFrom: { gt: effective } },
    orderBy: { effectiveFrom: "asc" },
    select: { effectiveFrom: true },
  });
  const previous = await db.teacherRateHistory.findFirst({
    where: { teacherId: tid, effectiveFrom: { lt: effective } },
    orderBy: { effectiveFrom: "desc" },
    select: { id: true },
  });

  const history = await db.teacherRateHistory.upsert({
    where: {
      teacherId_effectiveFrom: {
        teacherId: tid,
        effectiveFrom: effective,
      },
    },
    update: {
      ...rate,
      effectiveTo: next?.effectiveFrom || null,
      ...(createdById ? { createdById: Number(createdById) } : {}),
    },
    create: {
      teacherId: tid,
      ...rate,
      effectiveFrom: effective,
      effectiveTo: next?.effectiveFrom || null,
      createdById: createdById ? Number(createdById) : null,
    },
  });

  if (previous) {
    await db.teacherRateHistory.update({
      where: { id: previous.id },
      data: { effectiveTo: effective },
    });
  }

  return history;
}
