import test from "node:test";
import assert from "node:assert/strict";
import { validRecordingKey } from "../../src/services/classRecordingStorage.js";

test("Jibri object keys are tied to one numeric classroom session", () => {
  assert.equal(
    validRecordingKey(
      42,
      "class-recordings/session-42/speexify-classroom-42_2026-10-03-10-00-00.mp4"
    ),
    true
  );
  assert.equal(
    validRecordingKey(
      42,
      "class-recordings/session-43/speexify-classroom-43_2026-10-03-10-00-00.mp4"
    ),
    false
  );
  assert.equal(
    validRecordingKey(42, "class-recordings/session-42/../../other.mp4"),
    false
  );
  assert.equal(
    validRecordingKey(42, "class-recordings/session-42/speexify-classroom-42_bad.webm"),
    false
  );
});
