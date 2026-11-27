// The steps of a lesson recap: read the teacher's report, practise it, then
// do the homework. A step is left out when the lesson has nothing for it.

const REPORT_START = "[[SPEEXIFY_FEEDBACK_REPORT_V1]]";
const REPORT_END = "[[/SPEEXIFY_FEEDBACK_REPORT_V1]]";
const PRACTICE_TYPES = new Set(["vocabulary", "grammar", "pronunciation"]);

const REPORT_TYPES = new Set(["vocabulary", "grammar", "pronunciation", "note"]);
const MAX_REPORT_ITEMS = 80;
const MAX_TEXT = 2000;

function readPayload(commentsOnSession) {
  const raw = String(commentsOnSession || "");
  const start = raw.indexOf(REPORT_START);
  const end = raw.indexOf(REPORT_END);
  if (start === -1 || end <= start) return null;
  try {
    const payload = JSON.parse(raw.slice(start + REPORT_START.length, end));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

const text = (value) => (typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "");

// The rows of the teacher's report, cleaned up for the learner's unit page.
export function parseReportItems(commentsOnSession = "") {
  const payload = readPayload(commentsOnSession);
  if (!Array.isArray(payload?.items)) return [];
  return payload.items
    .filter((item) => item && REPORT_TYPES.has(item.type) && (text(item.prompt) || text(item.response)))
    .slice(0, MAX_REPORT_ITEMS)
    .map((item, index) => ({
      id: text(item.id).slice(0, 80) || `item-${index + 1}`,
      type: item.type,
      prompt: text(item.prompt),
      response: text(item.response),
      ...(text(item.note) ? { note: text(item.note) } : {}),
    }));
}

// Number of report rows the learner can practise (new words, mistakes and
// pronunciation). Plain-text feedback from before the report format has none.
export function countPracticeItems(commentsOnSession = "") {
  const payload = readPayload(commentsOnSession);
  if (!Array.isArray(payload?.items)) return 0;
  return payload.items.filter(
    (item) => PRACTICE_TYPES.has(item?.type) && String(item?.prompt || item?.response || "").trim()
  ).length;
}

export const HOMEWORK_DONE_STATUSES = new Set(["SUBMITTED", "REVIEWED"]);

export function computeLessonSteps({ hasFeedback = true, practiceItems = 0, progress = null, homework = [] } = {}) {
  const homeworkDone = homework.filter((a) => HOMEWORK_DONE_STATUSES.has(a.status)).length;
  const steps = {
    review: hasFeedback ? { done: Boolean(progress?.reviewedAt) } : null,
    practise: hasFeedback && practiceItems > 0 ? { done: Boolean(progress?.practisedAt) } : null,
    homework: homework.length ? { done: homeworkDone >= homework.length, total: homework.length, completed: homeworkDone } : null,
  };
  const order = ["review", "practise", "homework"];
  const next = order.find((key) => steps[key] && !steps[key].done) || null;
  const available = order.filter((key) => steps[key]);
  return { ...steps, next, done: available.length > 0 && next === null };
}
