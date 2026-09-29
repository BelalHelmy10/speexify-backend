import test from "node:test";
import assert from "node:assert/strict";
import { zonedDateTimeToUtc } from "../../src/services/timezone.js";

test("converts Cairo wall-clock time before the 2026 DST transition", () => {
  const value = zonedDateTimeToUtc({
    year: 2026,
    month: 10,
    day: 24,
    hour: 19,
    minute: 0,
    timeZone: "Africa/Cairo",
  });

  assert.equal(value.toISOString(), "2026-10-24T16:00:00.000Z");
});

test("converts Cairo wall-clock time after the 2026 DST transition", () => {
  const value = zonedDateTimeToUtc({
    year: 2026,
    month: 10,
    day: 31,
    hour: 19,
    minute: 0,
    timeZone: "Africa/Cairo",
  });

  assert.equal(value.toISOString(), "2026-10-31T17:00:00.000Z");
});
