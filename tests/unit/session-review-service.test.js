import test from "node:test";
import assert from "node:assert/strict";
import {
  isSessionReviewAvailable,
  normalizeReviewResources,
  sanitizeReviewResourceSnapshot,
} from "../../src/services/sessionReviewService.js";

test("session review is available after completion or the scheduled end", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");

  assert.equal(isSessionReviewAvailable({ status: "completed" }, now), true);
  assert.equal(isSessionReviewAvailable({
    status: "scheduled",
    endAt: "2026-10-10T11:59:59.000Z",
  }, now), true);
  assert.equal(isSessionReviewAvailable({
    status: "scheduled",
    endAt: "2026-10-10T12:00:01.000Z",
  }, now), false);
  assert.equal(isSessionReviewAvailable({
    status: "canceled",
    endAt: "2026-10-10T11:00:00.000Z",
  }, now), false);
});

test("review resource snapshots keep only safe display fields", () => {
  const snapshot = sanitizeReviewResourceSnapshot({
    title: "  Lesson handout  ",
    sourceType: "pdf",
    fileUrl: "https://cdn.sanity.io/handout.pdf",
    audioUrl: "https://example.test/private-audio.mp3",
    internalSecret: "do-not-store",
    classroomUpload: true,
  });

  assert.deepEqual(snapshot, {
    title: "Lesson handout",
    sourceType: "pdf",
    fileUrl: "https://cdn.sanity.io/handout.pdf",
    classroomUpload: true,
  });
});

test("review resources preserve opening order and normalize legacy ids", () => {
  const resources = normalizeReviewResources([
    "legacy-resource",
    {
      id: "modern-resource",
      title: "Workbook",
      firstOpenedAt: "2026-10-10T10:30:00.000Z",
      snapshot: { title: "Workbook", sourceType: "pdf" },
    },
    { resourceId: "modern-resource", title: "Duplicate" },
  ], { "legacy-resource": "2026-10-10T10:00:00.000Z" });

  assert.deepEqual(resources.map((resource) => resource.id), [
    "legacy-resource",
    "modern-resource",
  ]);
  assert.equal(resources[0].firstOpenedAt, "2026-10-10T10:00:00.000Z");
  assert.equal(resources[1].snapshot.title, "Workbook");
});
