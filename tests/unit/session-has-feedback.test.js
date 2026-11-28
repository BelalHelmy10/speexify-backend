import test from "node:test";
import assert from "node:assert/strict";
import { sessionHasFeedback } from "../../src/routes/sessions/learner.js";

test("feedback from the feedback record counts", () => {
  assert.equal(sessionHasFeedback({ feedback: { id: 1 } }), true);
});

test("feedback kept in the older session fields counts", () => {
  assert.equal(sessionHasFeedback({ feedback: null, teacherFeedbackComments: "Great progress" }), true);
  assert.equal(sessionHasFeedback({ teacherFeedbackFutureSteps: " Practise past tense " }), true);
});

test("no feedback, or only blank text, does not count", () => {
  assert.equal(sessionHasFeedback({ feedback: null }), false);
  assert.equal(sessionHasFeedback({ teacherFeedbackMessageToLearner: "   ", teacherFeedbackComments: "" }), false);
  assert.equal(sessionHasFeedback(null), false);
});
