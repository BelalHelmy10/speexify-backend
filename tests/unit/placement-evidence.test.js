import test from "node:test";
import assert from "node:assert/strict";
import { validatePlacementEvidence } from "../../src/services/placementEvidence.js";

const data = Buffer.alloc(200, 5).toString("base64");
const sample = (mime) => ({ writingTaskId: "workplace", speaking: { seconds: 60, audioDataUrl: `data:${mime};base64,${data}` } });
test("accepts browser audio MIME types including Chrome's codec parameter", () => {
  for (const mime of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]) assert.equal(validatePlacementEvidence(sample(mime)).ok, true);
});
test("rejects missing samples, invalid data and duration", () => {
  assert.equal(validatePlacementEvidence({ writingTaskId: "workplace" }).ok, false);
  assert.equal(validatePlacementEvidence(sample("text/html")).ok, false);
  const value = sample("audio/webm");
  value.speaking.seconds = 5;
  assert.equal(validatePlacementEvidence(value).ok, false);
  value.speaking.seconds = 60;
  value.speaking.audioDataUrl = "data:audio/webm;base64,!invalid";
  assert.equal(validatePlacementEvidence(value).ok, false);
});
test("live speaking request stays pending and drops unneeded recording data", () => {
  const result = validatePlacementEvidence({ writingTaskId: "everyday", speaking: { mode: "live", audioDataUrl: "discard" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.speaking, { mode: "live", status: "live_check_requested", seconds: 0 });
});
