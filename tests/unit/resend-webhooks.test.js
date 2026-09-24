import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyResendWebhookSignature } from "../../src/routes/resendWebhooks.js";

function buildSignature({ secret, body, id, timestamp }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
}

test("accepts a current valid Resend webhook signature", () => {
  const secret = `whsec_${Buffer.from("test-secret").toString("base64")}`;
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_1" } });
  const id = "evt_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = buildSignature({ secret, body, id, timestamp });

  assert.equal(
    verifyResendWebhookSignature({
      rawBody: Buffer.from(body),
      svixId: id,
      svixTimestamp: timestamp,
      svixSignature: `v1,${signature}`,
      secret,
    }),
    true
  );
});

test("rejects stale, malformed, and tampered webhook signatures", () => {
  const secret = `whsec_${Buffer.from("test-secret").toString("base64")}`;
  const body = "{}";
  const id = "evt_2";
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 601);
  const signature = buildSignature({ secret, body, id, timestamp: staleTimestamp });

  assert.equal(
    verifyResendWebhookSignature({
      rawBody: Buffer.from(body),
      svixId: id,
      svixTimestamp: staleTimestamp,
      svixSignature: `v1,${signature}`,
      secret,
    }),
    false
  );
  assert.equal(
    verifyResendWebhookSignature({
      rawBody: Buffer.from(body),
      svixId: id,
      svixTimestamp: String(Math.floor(Date.now() / 1000)),
      svixSignature: "v1,not-valid",
      secret,
    }),
    false
  );
});
