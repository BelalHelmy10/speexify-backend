import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotEntitlements, fulfillmentTerms } from '../../src/services/packageEntitlements.js';
test('payment fulfillment preserves purchased terms after package edits', () => {
  const pkg = {title:'Original', sessionsPerPack:12, durationMin:60};
  const entitlements = snapshotEntitlements(pkg);
  pkg.sessionsPerPack = 4; pkg.durationMin = 30; pkg.title = 'Changed';
  assert.deepEqual(fulfillmentTerms({pricingSnapshot:{entitlements}}, pkg),
    {version:1,lessonType:null,title:'Original',sessionsTotal:12,minutesPerSession:60,validityDays:365});
});
test('invalid snapshots fail rather than falling back to modified terms', () => {
  assert.throws(() => fulfillmentTerms({pricingSnapshot:{entitlements:{version:1}}}, {}));
});
