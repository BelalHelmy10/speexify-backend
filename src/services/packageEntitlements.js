/** Immutable fulfillment terms, captured when the customer creates an order. */
export function snapshotEntitlements(pkg) {
  const sessionsTotal = pkg.sessionsPerPack ?? 1;
  if (!Number.isInteger(sessionsTotal) || sessionsTotal < 1) {
    throw new Error("Package has invalid session entitlement");
  }
  const minutesPerSession = pkg.durationMin ?? null;
  if (minutesPerSession !== null && (!Number.isInteger(minutesPerSession) || minutesPerSession <= 0)) {
    throw new Error("Package has invalid session duration");
  }
  return { version: 1, lessonType: pkg.lessonType ?? null, title: pkg.title, sessionsTotal, minutesPerSession,
    validityDays: pkg.sessionsPerPack ? 365 : null };
}

export function fulfillmentTerms(order, pkg) {
  const saved = order.pricingSnapshot?.entitlements;
  // Older orders predate snapshots. Retain their existing fulfillment policy.
  if (!saved) return snapshotEntitlements(pkg);
  if (saved.version !== 1 || !Number.isInteger(saved.sessionsTotal) || saved.sessionsTotal < 1 ||
      typeof saved.title !== "string" ||
      (saved.minutesPerSession !== null && (!Number.isInteger(saved.minutesPerSession) || saved.minutesPerSession <= 0)) ||
      (saved.validityDays !== null && (!Number.isInteger(saved.validityDays) || saved.validityDays <= 0))) {
    throw new Error("Invalid stored entitlement snapshot");
  }
  return saved;
}
