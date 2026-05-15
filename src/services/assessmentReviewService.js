import { z } from "zod";

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);

function normalizeStringOrNull(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCefr(value) {
  const normalized = normalizeStringOrNull(value);
  return typeof normalized === "string" ? normalized.toUpperCase() : normalized;
}

function normalizeScore(value) {
  const normalized = normalizeStringOrNull(value);
  if (normalized === null || normalized === undefined) return normalized;
  if (typeof normalized === "number") return normalized;
  if (typeof normalized === "string") return Number(normalized);
  return normalized;
}

const ReviewMetaSchema = z.object({}).catchall(z.unknown());

export const AssessmentReviewBodySchema = z
  .object({
    score: z
      .preprocess(
        normalizeScore,
        z.number().int().min(0).max(100).nullable().optional()
      ),
    cefr: z
      .preprocess(normalizeCefr, z.enum(CEFR_LEVELS).nullable().optional()),
    feedback: z
      .preprocess(
        normalizeStringOrNull,
        z.string().max(5000).nullable().optional()
      ),
    meta: ReviewMetaSchema.nullable().optional(),
  })
  .strict();

export function parseAssessmentReviewBody(body) {
  return AssessmentReviewBodySchema.safeParse(body || {});
}

export function buildAssessmentReviewUpdateData({
  review,
  reviewerId,
  reviewedAt = new Date(),
}) {
  const reviewerIdNumber = Number(reviewerId);
  const data = {
    status: "reviewed",
    reviewedAt,
    reviewedById:
      Number.isInteger(reviewerIdNumber) && reviewerIdNumber > 0
        ? reviewerIdNumber
        : null,
  };

  if (hasOwn(review, "score")) {
    data.score = review.score;
  }

  if (hasOwn(review, "cefr")) {
    data.cefr = review.cefr;
  }

  if (hasOwn(review, "feedback")) {
    data.feedback = review.feedback;
  }

  if (hasOwn(review, "meta")) {
    data.reviewMeta = review.meta;
  }

  return data;
}
