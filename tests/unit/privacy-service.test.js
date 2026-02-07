import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_TYPES,
  getPrivacyPolicySummary,
  normalizePrivacyRequestStatus,
  normalizePrivacyRequestType,
} from "../../src/services/privacyService.js";

test("normalizePrivacyRequestType handles expected values and fallback", () => {
  assert.equal(normalizePrivacyRequestType("export"), PRIVACY_REQUEST_TYPES.EXPORT);
  assert.equal(normalizePrivacyRequestType(" DELETE "), PRIVACY_REQUEST_TYPES.DELETE);
  assert.equal(
    normalizePrivacyRequestType("unknown", PRIVACY_REQUEST_TYPES.EXPORT),
    PRIVACY_REQUEST_TYPES.EXPORT
  );
});

test("normalizePrivacyRequestStatus handles expected values and fallback", () => {
  assert.equal(
    normalizePrivacyRequestStatus("in_review"),
    PRIVACY_REQUEST_STATUSES.IN_REVIEW
  );
  assert.equal(
    normalizePrivacyRequestStatus("completed"),
    PRIVACY_REQUEST_STATUSES.COMPLETED
  );
  assert.equal(
    normalizePrivacyRequestStatus("n/a", PRIVACY_REQUEST_STATUSES.REJECTED),
    PRIVACY_REQUEST_STATUSES.REJECTED
  );
});

test("getPrivacyPolicySummary returns policy metadata and retention controls", () => {
  const summary = getPrivacyPolicySummary();

  assert.equal(typeof summary.policyVersion, "string");
  assert.ok(summary.policyVersion.length > 0);

  assert.equal(typeof summary.contactEmail, "string");
  assert.match(summary.contactEmail, /@/);

  assert.ok(Array.isArray(summary.rights));
  assert.ok(summary.rights.includes("access"));

  assert.equal(typeof summary.retentionDays.verificationCodes, "number");
  assert.equal(typeof summary.retentionDays.notifications, "number");
  assert.equal(typeof summary.retentionDays.audits, "number");
  assert.equal(typeof summary.retentionDays.supportTickets, "number");

  assert.ok(summary.retentionDays.verificationCodes > 0);
  assert.ok(summary.retentionDays.notifications > 0);
  assert.ok(summary.retentionDays.audits > 0);
  assert.ok(summary.retentionDays.supportTickets > 0);
});
