import test from "node:test";
import assert from "node:assert/strict";
import {
  getTeacherRateAt,
  selectEffectiveTeacherRate,
} from "../../src/services/teacherRateService.js";

test("effective rate lookup uses the latest rate at the session completion time", async () => {
  const history = [
    {
      id: 1,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      rateHourlyEgpPiastres: 12000,
      ratePerSessionEgpPiastres: null,
    },
    {
      id: 2,
      effectiveFrom: new Date("2026-09-15T00:00:00.000Z"),
      rateHourlyEgpPiastres: 24000,
      ratePerSessionEgpPiastres: null,
    },
  ];
  const db = {
    teacherRateHistory: {
      findFirst: async ({ where, orderBy }) => {
        assert.deepEqual(orderBy, { effectiveFrom: "desc" });
        return history
          .filter(
            (entry) =>
              entry.teacherId === undefined ||
              entry.effectiveFrom <= where.effectiveFrom.lte
          )
          .sort((left, right) => right.effectiveFrom - left.effectiveFrom)[0] || null;
      },
    },
  };

  const rate = await getTeacherRateAt(
    3,
    new Date("2026-09-20T12:00:00.000Z"),
    db
  );

  assert.equal(rate.rateHourlyEgpPiastres, 24000);
  assert.equal(rate.source, "history");
});

test("a future-only history does not fall back to today's rate for older sessions", async () => {
  let calls = 0;
  const db = {
    teacherRateHistory: {
      findFirst: async ({ where }) => {
        calls += 1;
        if (calls === 1) return null;
        assert.equal(where.teacherId, 3);
        return { id: 5 };
      },
    },
  };

  const rate = await getTeacherRateAt(
    3,
    new Date("2026-09-20T12:00:00.000Z"),
    db,
    {
      fallback: { rateHourlyEgpPiastres: 24000 },
      allowFallback: true,
    }
  );

  assert.equal(rate, null);
});

test("completion fallback is allowed only when no history exists", () => {
  const rate = selectEffectiveTeacherRate({
    fallback: { rateHourlyEgpPiastres: 12000 },
    allowFallback: true,
  });
  assert.equal(rate.rateHourlyEgpPiastres, 12000);
  assert.equal(rate.source, "completion_current_rate");
});
