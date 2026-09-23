import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTeacherEarning,
  isTeacherEarningsUnavailable,
  TEACHER_EARNINGS_CURRENCY,
  validatePayoutEntries,
} from "../../src/services/teacherEarningsService.js";

test("teacher earnings use EGP piastres and hourly duration", () => {
  const result = calculateTeacherEarning({ rateHourlyEgpPiastres: 12000, minutes: 45 });
  assert.equal(TEACHER_EARNINGS_CURRENCY, "EGP");
  assert.deepEqual(result, { amountMinor: 9000, rateType: "hourly", rateMinor: 12000 });
});

test("per-session rates stay fixed regardless of duration", () => {
  const result = calculateTeacherEarning({ ratePerSessionEgpPiastres: 8500, minutes: 90 });
  assert.deepEqual(result, { amountMinor: 8500, rateType: "per_session", rateMinor: 8500 });
});

test("missing rates create a visible zero-value configuration entry", () => {
  const result = calculateTeacherEarning({ minutes: 60 });
  assert.deepEqual(result, { amountMinor: 0, rateType: "none", rateMinor: null });
});

test("legacy ambiguous rate fields are ignored by the EGP ledger", () => {
  const result = calculateTeacherEarning({ rateHourlyCents: 1000, minutes: 60 });
  assert.deepEqual(result, { amountMinor: 0, rateType: "none", rateMinor: null });
});

test("payout validation returns the exact EGP total for valid pending entries", () => {
  assert.equal(
    validatePayoutEntries([1, 2], [{ id: 1, amountMinor: 9000 }, { id: 2, amountMinor: 8500 }]),
    17500
  );
});

test("payout validation rejects missing, duplicate, and unconfigured entries", () => {
  assert.throws(
    () => validatePayoutEntries([1, 2], [{ id: 1, amountMinor: 9000 }]),
    (error) => error.code === "INVALID_EARNINGS"
  );
  assert.throws(
    () => validatePayoutEntries([1, 1], [{ id: 1, amountMinor: 9000 }]),
    (error) => error.code === "INVALID_EARNINGS"
  );
  assert.throws(
    () => validatePayoutEntries([1], [{ id: 1, amountMinor: 0 }]),
    (error) => error.code === "RATE_NOT_CONFIGURED"
  );
});

test("migration-unavailable errors are distinguishable from ordinary failures", () => {
  assert.equal(isTeacherEarningsUnavailable({ code: "P2021" }), true);
  assert.equal(isTeacherEarningsUnavailable(new Error('The table "TeacherEarning" does not exist')), true);
  assert.equal(isTeacherEarningsUnavailable(new Error("network timeout")), false);
});
