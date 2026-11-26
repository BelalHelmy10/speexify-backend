import test from "node:test";
import assert from "node:assert/strict";
import {
  contentForLearner,
  countCompletedTasks,
  getHomeworkTemplate,
  isAcceptedAnswer,
  listHomeworkTemplates,
  markAll,
  markTask,
  normalizeAnswer,
  sanitizeAnswers,
  suggestTemplateId,
  taskFields,
} from "../../src/services/homeworkService.js";

test("all five First Impressions templates load with consistent tasks", () => {
  const templates = listHomeworkTemplates();
  assert.deepEqual(
    templates.map((t) => t.id),
    ["first-impressions-a1", "first-impressions-a2", "first-impressions-b1", "first-impressions-b2", "first-impressions-c1"]
  );
  for (const summary of templates) {
    const t = getHomeworkTemplate(summary.id);
    assert.equal(t.tasks.length, 6, `${t.id} has 6 tasks`);
    for (const task of t.tasks) {
      assert.ok(taskFields(task).length > 0, `${t.id} ${task.id} has fields`);
      if (task.type === "gaps") {
        for (const item of task.items) {
          const gaps = (item.text.match(/___/g) || []).length;
          assert.equal(gaps, item.answers.length, `${t.id} ${task.id} ${item.id} gap count`);
        }
      }
      if (task.type === "match") {
        const keys = new Set(task.options.map((o) => o.key));
        for (const item of task.items) for (const a of item.answer) assert.ok(keys.has(a), `${t.id} ${task.id} answer ${a} is an option`);
      }
    }
  }
});

test("normalizeAnswer forgives case, curly quotes, final punctuation and contractions", () => {
  assert.equal(normalizeAnswer("  I’m from Cairo. "), normalizeAnswer("i am from cairo"));
  assert.ok(isAcceptedAnswer("It is really hot today, isn’t it", ["It's really hot today, isn't it?"]));
  assert.ok(isAcceptedAnswer("Let us catch up later", ["Let's catch up later!"]));
  assert.ok(!isAcceptedAnswer("", ["anything"]));
  assert.ok(!isAcceptedAnswer("I'm from in Cairo.", ["I'm from Cairo."]));
});

test("markTask marks match, gaps and keyed rewrite tasks; open tasks return null", () => {
  const a1 = getHomeworkTemplate("first-impressions-a1");
  const [match, gaps, rewrite, writing] = a1.tasks;

  const m = markTask(match, { i1: "c", i2: "e", i3: "b" });
  assert.equal(m.fields.i1, true);
  assert.equal(m.fields.i2, true, "d|e alternatives accepted");
  assert.equal(m.fields.i3, false);
  assert.equal(m.total, 6);

  const g = markTask(gaps, { "i1.0": "am", "i2.0": "from", "i2.1": "lives" });
  assert.deepEqual([g.fields["i1.0"], g.fields["i2.0"], g.fields["i2.1"]], [true, true, false]);

  const r = markTask(rewrite, { i1: "I am from Cairo", i2: "I'm engineer." });
  assert.equal(r.fields.i1, true);
  assert.equal(r.fields.i2, false);

  assert.equal(markTask(writing, { p1: "Hi, I'm Omar" }), null);
});

test("sanitizeAnswers keeps only known fields with the right types", () => {
  const a1 = getHomeworkTemplate("first-impressions-a1");
  const clean = sanitizeAnswers(a1, {
    t1: { i1: "c", hacked: "x", i2: 5 },
    t5: { "step.0": true, "step.1": "yes", reflection: "  " },
    tX: { i1: "nope" },
  });
  assert.deepEqual(clean, { t1: { i1: "c" }, t5: { "step.0": true } });
});

test("progress counts a task only when every required field is done", () => {
  const a1 = getHomeworkTemplate("first-impressions-a1");
  const match = a1.tasks[0];
  const all = Object.fromEntries(match.items.map((i) => [i.id, "a"]));
  assert.equal(countCompletedTasks(a1, { t1: all }), 1);
  const partial = { ...all };
  delete partial.i6;
  assert.equal(countCompletedTasks(a1, { t1: partial }), 0);
  const steps = Object.fromEntries(a1.tasks[4].steps.map((_, i) => [`step.${i}`, true]));
  assert.equal(countCompletedTasks(a1, { t1: all, t5: steps }), 2, "reflection is optional");
});

test("contentForLearner removes every answer key and model answer", () => {
  for (const { id } of listHomeworkTemplates()) {
    const safe = JSON.stringify(contentForLearner(getHomeworkTemplate(id)));
    assert.ok(!safe.includes('"answer"'), `${id}: no answer fields`);
    assert.ok(!safe.includes('"answers"'), `${id}: no gap answers`);
    assert.ok(!safe.includes('"models"'), `${id}: no model answers`);
  }
  const b1 = contentForLearner(getHomeworkTemplate("first-impressions-b1"));
  assert.equal(b1.tasks[1].items[0].gapCount, 2);
  assert.deepEqual(
    b1.tasks.map((t) => t.checkable),
    [true, true, false, true, false, false],
    "match, gaps and keyed rewrite tasks are checkable"
  );
});

test("markAll totals only auto-marked tasks", () => {
  const b2 = getHomeworkTemplate("first-impressions-b2");
  const result = markAll(b2, { t1: { i1: "d" } });
  assert.deepEqual(Object.keys(result.byTask), ["t1", "t2"]);
  assert.equal(result.byTask.t1.correct, 1);
  assert.equal(result.total, 6 + 7);
});

test("suggestTemplateId matches the lesson opened in class", () => {
  assert.equal(
    suggestTemplateId([{ id: "resource-speexify-trial-b2-first-impressions-lesson" }]),
    "first-impressions-b2"
  );
  assert.equal(suggestTemplateId(["something-else"]), null);
  assert.equal(suggestTemplateId(null), null);
});
