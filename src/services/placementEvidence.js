const TASKS = new Set(["workplace", "decision", "everyday"]);
const AUDIO = /^data:(audio\/(?:webm|mp4|ogg|wav|mpeg))(?:;codecs=[a-z0-9.,-]+)?;base64,([A-Za-z0-9+/]+={0,2})$/i;

export function validatePlacementEvidence(meta) {
  if (!TASKS.has(meta?.writingTaskId)) return { ok: false, status: 400, error: "Choose a valid writing task" };
  const speaking = meta.speaking;
  if (speaking?.mode === "live") return {
    ok: true, writingTaskId: meta.writingTaskId,
    speaking: { mode: "live", status: "live_check_requested", seconds: 0 },
  };
  const seconds = speaking?.seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 30 || seconds > 180) {
    return { ok: false, status: 400, error: "Record 30–180 seconds or request a live speaking check" };
  }
  const value = speaking?.audioDataUrl;
  if (typeof value !== "string" || value.length > 3_000_000) return { ok: false, status: 413, error: "Speaking recording is missing or too large" };
  const match = AUDIO.exec(value);
  if (!match || Buffer.from(match[2], "base64").length < 100) return { ok: false, status: 400, error: "Speaking recording is invalid" };
  return {
    ok: true, writingTaskId: meta.writingTaskId,
    speaking: { mode: "recording", seconds, mimeType: match[1], audioDataUrl: value },
  };
}
