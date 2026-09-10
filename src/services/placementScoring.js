const OBJECTIVE_ANSWER_KEYS = {
  language: {
    c1: 1, c2: 0, c3: 1, c4: 1, c5: 1, c6: 2, c7: 0, c8: 1,
    c9: 2, c10: 2, c11: 1, c12: 0, c13: 0, c14: 1, c15: 2, c16: 0,
    c17: 1, c18: 0, c19: 0, c20: 0, c21: 0, c22: 0, c23: 0, c24: 0,
  },
  reading: {
    r1q1: 1, r1q2: 2, r1q3: 1, r1q4: 1,
    r2q1: 1, r2q2: 1, r2q3: 2, r2q4: 0,
    r3q1: 1, r3q2: 1, r3q3: 0, r3q4: 1,
  },
  listening: {
    l1q1: 1, l1q2: 2, l1q3: 0,
    l2q1: 1, l2q2: 1, l2q3: 1,
    l3q1: 0, l3q2: 1, l3q3: 2,
  },
};

const OBJECTIVE_WEIGHTS = { language: 0.45, reading: 0.3, listening: 0.25 };

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseAnswer(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 3) return value;
  if (typeof value === "string" && /^(?:-1|[0-3])$/.test(value)) return Number(value);
  return null;
}

function scoreGroup(answerKey, answers) {
  const entries = Object.entries(answerKey);
  const answered = entries.filter(([id]) => parseAnswer(answers[id]) !== null).length;
  const correct = entries.reduce(
    (total, [id, answer]) => total + (parseAnswer(answers[id]) === answer ? 1 : 0),
    0,
  );
  return {
    answered,
    total: entries.length,
    correct,
    score: entries.length ? Math.round((correct / entries.length) * 100) : 0,
  };
}

export function scoreObjectiveAssessment(input = {}) {
  const answers = asObject(input);
  const language = scoreGroup(OBJECTIVE_ANSWER_KEYS.language, asObject(answers.coreAnswers));
  const reading = scoreGroup(OBJECTIVE_ANSWER_KEYS.reading, asObject(answers.readingAnswers));
  const listening = scoreGroup(OBJECTIVE_ANSWER_KEYS.listening, asObject(answers.listeningAnswers));
  const total = language.total + reading.total + listening.total;
  const answered = language.answered + reading.answered + listening.answered;
  const score = Math.round(
    language.score * OBJECTIVE_WEIGHTS.language +
      reading.score * OBJECTIVE_WEIGHTS.reading +
      listening.score * OBJECTIVE_WEIGHTS.listening,
  );


  return {
    version: "speexify-placement-server-v1",
    score,
    band: null, // A coach assigns CEFR after reviewing productive skills; cut scores are not calibrated.
    complete: answered === total,
    answered,
    total,
    sectionScores: { language: language.score, reading: reading.score, listening: listening.score },
    sections: { language, reading, listening },
  };
}

export function hasCompleteObjectiveAssessment(input = {}) {
  return scoreObjectiveAssessment(input).complete;
}
