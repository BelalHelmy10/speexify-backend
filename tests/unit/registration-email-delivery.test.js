import test from "node:test";
import assert from "node:assert/strict";
import { deliverVerificationCode } from "../../src/services/registrationEmail.js";

test("verification delivery passes the localized message to the provider", async () => {
  let call;
  const providerResult = { sent: true, deliveryId: 42 };

  const result = await deliverVerificationCode(
    { email: "learner@example.com", code: "123456", locale: "en" },
    async (...args) => {
      call = args;
      return providerResult;
    }
  );

  assert.equal(result, providerResult);
  assert.equal(call[0], "learner@example.com");
  assert.match(call[1], /verification code/i);
  assert.match(call[2], /123456/);
  assert.deepEqual(call[3], {
    locale: "en",
    eventType: "email_verification",
    track: true,
  });
});

test("verification delivery rejects a provider result that was not sent", async () => {
  await assert.rejects(
    () =>
      deliverVerificationCode(
        { email: "learner@example.com", code: "123456" },
        async () => ({ sent: false, deliveryId: 99 })
      ),
    (error) => {
      assert.equal(error.code, "EMAIL_NOT_SENT");
      assert.equal(error.deliveryId, 99);
      return true;
    }
  );
});

test("verification delivery preserves provider failures", async () => {
  const providerError = new Error("Resend rejected the request");

  await assert.rejects(
    () =>
      deliverVerificationCode(
        { email: "learner@example.com", code: "123456" },
        async () => {
          throw providerError;
        }
      ),
    (error) => error === providerError
  );
});
