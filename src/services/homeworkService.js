// src/services/homeworkService.js
// Interactive homework: templates, answer handling, progress and auto-marking.
//
// Templates live in src/content/homework/*.json. They are generated from the
// lesson source in materials/trial-session/src (export-homework.mjs), so the
// PDF and the interactive version always share the same text.
//
// Answers are stored per task id, then per field key:
//   match    : { [itemId]: "c" }
//   gaps     : { "<itemId>.<gapIndex>": "text" }
//   rewrite  : { [itemId]: "text" }
//   writing  : { [partId]: "text", "check.<i>": true }
//   checklist: { "step.<i>": true, "check.<i>": true, reflection: "text" }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../content/homework"
);

export const MAX_FIELD_LENGTH = 6000;
export const MAX_ANSWERS_BYTES = 200_000;

let cache = null;

export function loadHomeworkTemplates({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const files = fs.existsSync(TEMPLATE_DIR)
    ? fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".json"))
    : [];
  cache = files
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), "utf8")))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return cache;
}

export function getHomeworkTemplate(id) {
  return loadHomeworkTemplates().find((t) => t.id === id) || null;
}

/** Short list for the teacher's "Assign homework" picker. */
export function listHomeworkTemplates() {
  return loadHomeworkTemplates().map((t) => ({
    id: t.id,
    title: t.title,
    topic: t.topic,
    level: t.level,
    minutes: t.minutes,
    taskCount: t.tasks.length,
    resourceIds: t.resourceIds || [],
  }));
}

/**
 * Pick the template that matches what the teacher opened in class:
 * session.resourcesUsed holds the CMS resource ids opened in the classroom.
 */
export function suggestTemplateId(resourcesUsed) {
  const opened = new Set(
    (Array.isArray(resourcesUsed) ? resourcesUsed : [])
      .map((r) => (typeof r === "string" ? r : r?.id))
      .filter(Boolean)
  );
  const match = loadHomeworkTemplates().find((t) =>
    (t.resourceIds || []).some((id) => opened.has(id))
  );
  return match ? match.id : null;
}

// ─── Answer keys ──────────────────────────────────────────────────────────

/** Every field the learner can fill in for a task, with whether it is required. */
export function taskFields(task) {
  switch (task.type) {
    case "match":
    case "rewrite":
      return task.items.map((item) => ({ key: item.id, kind: "text" }));
    case "gaps":
      return task.items.flatMap((item) =>
        (item.answers || []).map((_, gi) => ({ key: `${item.id}.${gi}`, kind: "text" }))
      );
    case "writing": {
      const parts = task.parts.length
        ? task.parts.map((p) => ({ key: p.id, kind: "text" }))
        : [{ key: "text", kind: "text" }];
      const checks = (task.checklist || []).map((_, i) => ({ key: `check.${i}`, kind: "bool", optional: true }));
      return [...parts, ...checks];
    }
    case "checklist": {
      const steps = (task.steps || []).map((_, i) => ({ key: `step.${i}`, kind: "bool" }));
      const checks = (task.checklist || []).map((_, i) => ({ key: `check.${i}`, kind: "bool", optional: true }));
      const reflection = task.reflection ? [{ key: "reflection", kind: "text", optional: true }] : [];
      return [...steps, ...checks, ...reflection];
    }
    default:
      return [];
  }
}

/**
 * Keep only known tasks and fields, with the right value types and lengths.
 * Unknown keys are dropped silently so an old browser tab can't corrupt data.
 */
export function sanitizeAnswers(content, rawAnswers) {
  const out = {};
  const raw = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  for (const task of content?.tasks || []) {
    const given = raw[task.id];
    if (!given || typeof given !== "object") continue;
    const clean = {};
    for (const field of taskFields(task)) {
      const value = given[field.key];
      if (value === undefined || value === null) continue;
      if (field.kind === "bool") {
        if (value === true) clean[field.key] = true;
      } else if (typeof value === "string") {
        const text = value.slice(0, MAX_FIELD_LENGTH);
        if (text.trim()) clean[field.key] = text;
      }
    }
    if (Object.keys(clean).length) out[task.id] = clean;
  }
  return out;
}

export function isTaskComplete(task, taskAnswers = {}) {
  const required = taskFields(task).filter((f) => !f.optional);
  if (!required.length) return false;
  return required.every((f) =>
    f.kind === "bool" ? taskAnswers[f.key] === true : String(taskAnswers[f.key] || "").trim().length > 0
  );
}

export function countCompletedTasks(content, answers = {}) {
  return (content?.tasks || []).filter((task) => isTaskComplete(task, answers[task.id])).length;
}

// ─── Marking ──────────────────────────────────────────────────────────────

const CONTRACTIONS = [
  [/\bi'm\b/g, "i am"],
  [/\b(it|that|what|he|she|there)'s\b/g, "$1 is"],
  [/\blet's\b/g, "let us"],
  [/\b(you|we|they)'re\b/g, "$1 are"],
  [/\b(is|are|do|does|did|was|were|have|has)n't\b/g, "$1 not"],
  [/\bcan't\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\b(i|you|we|they)'ve\b/g, "$1 have"],
  [/\b(i|you|we|they|he|she)'ll\b/g, "$1 will"],
];

export function normalizeAnswer(value) {
  let s = String(value ?? "")
    .toLowerCase()
    .replace(/[‘’‛′`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\s.!?,;:]+$/g, "")
    .trim();
  for (const [pattern, replacement] of CONTRACTIONS) s = s.replace(pattern, replacement);
  return s;
}

export function isAcceptedAnswer(given, accepted = []) {
  const g = normalizeAnswer(given);
  if (!g) return false;
  return accepted.some((a) => normalizeAnswer(a) === g);
}

/** Whether a task has answers the system can mark on its own. */
export function isAutoMarked(task) {
  if (task.type === "match" || task.type === "gaps") return true;
  if (task.type === "rewrite") return task.items.some((i) => Array.isArray(i.answer) && i.answer.length);
  return false;
}

/**
 * Mark one task. Returns { fields: { key: true|false }, correct, total }.
 * Empty fields count as wrong. Tasks without answer keys return null.
 */
export function markTask(task, taskAnswers = {}) {
  if (!isAutoMarked(task)) return null;
  const fields = {};
  if (task.type === "match" || task.type === "rewrite") {
    for (const item of task.items) {
      if (!Array.isArray(item.answer) || !item.answer.length) continue;
      fields[item.id] = isAcceptedAnswer(taskAnswers[item.id], item.answer);
    }
  } else if (task.type === "gaps") {
    for (const item of task.items) {
      (item.answers || []).forEach((accepted, gi) => {
        const key = `${item.id}.${gi}`;
        fields[key] = isAcceptedAnswer(taskAnswers[key], accepted);
      });
    }
  }
  const values = Object.values(fields);
  return { fields, correct: values.filter(Boolean).length, total: values.length };
}

export function markAll(content, answers = {}) {
  const byTask = {};
  let correct = 0;
  let total = 0;
  for (const task of content?.tasks || []) {
    const result = markTask(task, answers[task.id]);
    if (!result) continue;
    byTask[task.id] = { correct: result.correct, total: result.total };
    correct += result.correct;
    total += result.total;
  }
  return { correct, total, byTask };
}

// ─── What each role is allowed to see ─────────────────────────────────────

/** Remove answer keys and model answers before sending content to a learner. */
export function contentForLearner(content) {
  return {
    ...content,
    tasks: (content?.tasks || []).map((task) => {
      const { models, ...fields } = task;
      // `checkable` tells the page whether to offer "Check my answers".
      const rest = { ...fields, checkable: isAutoMarked(task) };
      if (task.type === "match" || task.type === "rewrite") {
        return { ...rest, items: task.items.map(({ answer, ...item }) => item) };
      }
      if (task.type === "gaps") {
        return {
          ...rest,
          items: task.items.map(({ answers, ...item }) => ({ ...item, gapCount: (answers || []).length })),
        };
      }
      return rest;
    }),
  };
}

export function buildAssignmentContent(template) {
  // Deep copy so the stored snapshot can never share references with the cache.
  return JSON.parse(JSON.stringify(template));
}
