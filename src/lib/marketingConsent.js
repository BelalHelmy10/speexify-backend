export const MARKETING_PHONE_CONSENT_VERSION = "v1";

export function hasActiveMarketingPhoneConsent(user) {
  return Boolean(
    user?.phone &&
      user?.marketingPhoneConsentAt &&
      !user?.marketingPhoneOptOutAt
  );
}
