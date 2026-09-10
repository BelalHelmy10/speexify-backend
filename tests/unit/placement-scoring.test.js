import test from "node:test";
import assert from "node:assert/strict";
import { scoreObjectiveAssessment } from "../../src/services/placementScoring.js";

const keys = {
  coreAnswers: {
    c1: 1, c2: 0, c3: 1, c4: 1, c5: 1, c6: 2, c7: 0, c8: 1,
    c9: 2, c10: 2, c11: 1, c12: 0, c13: 0, c14: 1, c15: 2, c16: 0,
    c17: 1, c18: 0, c19: 0, c20: 0, c21: 0, c22: 0, c23: 0, c24: 0,
  },
  readingAnswers: {
    r1q1: 1, r1q2: 2, r1q3: 1, r1q4: 1,
    r2q1: 1, r2q2: 1, r2q3: 2, r2q4: 0,
    r3q1: 1, r3q2: 1, r3q3: 0, r3q4: 1,
  },
  listeningAnswers: {
    l1q1: 1, l1q2: 2, l1q3: 0,
    l2q1: 1, l2q2: 1, l2q3: 1,
    l3q1: 0, l3q2: 1, l3q3: 2,
  },
};

test("server placement scoring returns a complete objective result without assigning CEFR for all correct answers", () => {
  const result = scoreObjectiveAssessment(keys);
  assert.equal(result.complete, true);
  assert.equal(result.score, 100);
  assert.equal(result.band, null);
  assert.deepEqual(result.sectionScores, { language: 100, reading: 100, listening: 100 });
});

test("server placement scoring never trusts missing or invalid answers", () => {
  const result = scoreObjectiveAssessment({
    coreAnswers: { c1: null, c2: 0 },
    readingAnswers: {},
    listeningAnswers: {},
  });
  assert.equal(result.complete, false);
  assert.equal(result.answered, 1);
  assert.equal(result.total, 45);
  assert.equal(result.score, 2);
});

test("server placement scoring rejects out-of-range answer indexes", () => {
  const result = scoreObjectiveAssessment({
    coreAnswers: { c1: 4, c2: -2, c3: "" },
    readingAnswers: {},
    listeningAnswers: {},
  });
  assert.equal(result.answered, 0);
  assert.equal(result.complete, false);
});
