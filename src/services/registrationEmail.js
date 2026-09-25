import { sendEmail } from "./emailService.js";
import { verificationEmail } from "./emailTemplates.js";

/**
 * Deliver a registration verification code before the registration flow is
 * allowed to proceed. Verification codes are user-blocking transactional
 * messages, so queueing them without confirming provider acceptance would
 * make the UI claim success while no message has actually been sent.
 */
export async function deliverVerificationCode(
  { email, code, locale = "en" },
  send = sendEmail
) {
  const content = verificationEmail({ code, locale });
  const result = await send(email, content.subject, content.html, {
    locale,
    eventType: "email_verification",
    track: true,
  });

  if (result?.sent !== true) {
    const error = new Error(
      result?.suppressed
        ? "The verification recipient is suppressed"
        : "The email provider did not accept the verification message"
    );
    error.code = result?.suppressed
      ? "EMAIL_RECIPIENT_SUPPRESSED"
      : "EMAIL_NOT_SENT";
    error.deliveryId = result?.deliveryId || null;
    throw error;
  }

  return result;
}
