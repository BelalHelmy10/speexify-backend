import test from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, normalizePhone } from "../../src/lib/phone.js";

test("normalizePhone stores international numbers in a compact format", () => {
  assert.equal(normalizePhone("+20 (10) 1234-5678"), "+201012345678");
  assert.equal(normalizePhone("010 1234 5678"), "01012345678");
});

test("normalizePhone treats blank values as no phone", () => {
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(isValidPhone("   "), false);
});

test("normalizePhone rejects numbers outside the supported digit range", () => {
  assert.equal(isValidPhone("1234567"), false);
  assert.equal(isValidPhone("1234567890123456"), false);
  assert.throws(() => normalizePhone("1234567"), /8 to 15 digits/);
});
