import test from "node:test";
import assert from "node:assert/strict";
import { generateSlots, localToInstant, tokenHash } from "../../src/services/trialBookings.js";

test("Cairo input resolves seasonal offsets and rejects invalid dates and DST gaps/folds", () => {
  assert.equal(localToInstant("2027-01-10", "18:00").toISOString(), "2027-01-10T16:00:00.000Z");
  assert.equal(localToInstant("2027-07-10", "18:00").toISOString(), "2027-07-10T15:00:00.000Z");
  assert.throws(() => localToInstant("2027-02-30", "18:00"), /AMBIGUOUS_OR_INVALID_TIME/);
  assert.throws(() => localToInstant("2027-04-30", "00:30"), /AMBIGUOUS_OR_INVALID_TIME/);
  assert.throws(() => localToInstant("2027-10-28", "23:30"), /AMBIGUOUS_OR_INVALID_TIME/);
});
test("generated times fit full sessions and include trainer buffers", () => {
  const date = `${new Date().getUTCFullYear() + 1}-01-10`;
  const slots = generateSlots({ date, startTime: "09:00", endTime: "11:00", durationMin: 30, bufferMin: 10, capacity: 3 });
  assert.equal(slots.length, 3);
  assert.equal(slots[1].startAt - slots[0].startAt, 40 * 60000);
  assert.equal(slots[2].endAt - slots[0].startAt, 110 * 60000);
  assert.equal(slots[0].capacity, 3);
  assert.throws(() => generateSlots({ date, startTime: "09:00", endTime: "09:15", durationMin: 30, bufferMin: 10, capacity: 1 }), /INVALID_DATE/);
});
test("management secrets are stored as hashes", () => {
  const token = "1".repeat(64);
  assert.notEqual(tokenHash(token), token);
  assert.equal(tokenHash(token).length, 64);
});
