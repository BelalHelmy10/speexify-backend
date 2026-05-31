import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssessmentReviewUpdateData,
  parseAssessmentReviewBody,
} from "../../src/services/assessmentReviewService.js";

test("parseAssessmentReviewBody normalizes valid review input", () => {
  const parsed = parseAssessmentReviewBody({
    score: "87",
    cefr: " b2.2 ",
    feedback: "  Clear structure; work on article usage.  ",
    meta: { rubric: { grammar: 80, clarity: 90 } },
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.score, 87);
  assert.equal(parsed.data.cefr, "B2.2");
  assert.equal(parsed.data.feedback, "Clear structure; work on article usage.");
  assert.deepEqual(parsed.data.meta, { rubric: { grammar: 80, clarity: 90 } });
});

test("parseAssessmentReviewBody allows explicit nullable fields", () => {
  const parsed = parseAssessmentReviewBody({
    score: "",
    cefr: "",
    feedback: "",
    meta: null,
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.score, null);
  assert.equal(parsed.data.cefr, null);
  assert.equal(parsed.data.feedback, null);
  assert.equal(parsed.data.meta, null);
});

test("parseAssessmentReviewBody rejects invalid review payloads", () => {
  assert.equal(parseAssessmentReviewBody({ score: true }).success, false);
  assert.equal(parseAssessmentReviewBody({ score: 101 }).success, false);
  assert.equal(parseAssessmentReviewBody({ cefr: "Z9" }).success, false);
  assert.equal(
    parseAssessmentReviewBody({ score: 90, unexpected: true }).success,
    false
  );
});

test("buildAssessmentReviewUpdateData maps API fields to Prisma fields", () => {
  const reviewedAt = new Date("2026-05-15T09:00:00.000Z");
  const data = buildAssessmentReviewUpdateData({
    review: {
      score: 92,
      cefr: "C1",
      feedback: "Ready for advanced presentation practice.",
      meta: { reviewerNotes: "Strong cohesion" },
    },
    reviewerId: 7,
    reviewedAt,
  });

  assert.deepEqual(data, {
    status: "reviewed",
    reviewedAt,
    reviewedById: 7,
    score: 92,
    cefr: "C1",
    feedback: "Ready for advanced presentation practice.",
    reviewMeta: { reviewerNotes: "Strong cohesion" },
  });
});
