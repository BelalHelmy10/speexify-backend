import test from "node:test";
import assert from "node:assert/strict";
import { overlapsFilter } from "../../src/services/sessionsService.js";

test("overlapsFilter builds overlap condition for bounded sessions", () => {
  const startAt = "2026-02-01T10:00:00.000Z";
  const endAt = "2026-02-01T11:00:00.000Z";
  const filter = overlapsFilter(startAt, endAt);

  assert.equal(filter.startAt.lt.toISOString(), endAt);
  assert.equal(filter.OR[0].endAt.gt.toISOString(), startAt);
  assert.deepEqual(filter.OR[1], { endAt: null });
});

test("overlapsFilter uses far-future end when endAt is not provided", () => {
  const startAt = "2026-02-01T10:00:00.000Z";
  const filter = overlapsFilter(startAt, null);

  assert.equal(filter.startAt.lt.toISOString(), "2999-12-31T00:00:00.000Z");
  assert.equal(filter.OR[0].endAt.gt.toISOString(), startAt);
});
