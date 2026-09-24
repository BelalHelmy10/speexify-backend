import test from "node:test";
import assert from "node:assert/strict";
import {
  bookingLearnerEmail,
  formatEmailDate,
  normalizeEmailLocale,
  passwordResetEmail,
  reminderEmail,
} from "../../src/services/emailTemplates.js";

test("email locale normalization only enables supported Arabic explicitly", () => {
  assert.equal(normalizeEmailLocale("ar-EG"), "ar");
  assert.equal(normalizeEmailLocale("en"), "en");
  assert.equal(normalizeEmailLocale(undefined), "en");
});

test("Arabic transactional email is RTL and uses localized copy", () => {
  const email = bookingLearnerEmail({
    name: "سارة",
    sessionTitle: "محادثة إنجليزية",
    teacherName: "أحمد",
    when: formatEmailDate("2026-09-24T10:00:00.000Z", "Africa/Cairo", "ar"),
    joinUrl: "https://app.speexify.com/classroom/1",
    locale: "ar",
  });

  assert.match(email.html, /lang="ar"/);
  assert.match(email.html, /dir="rtl"/);
  assert.match(email.html, /تم تأكيد الحصة/);
  assert.match(email.html, /ادخل إلى الفصل/);
  assert.match(email.subject, /تم تأكيد الحصة/);
});

test("email templates escape dynamic content before durable delivery", () => {
  const email = bookingLearnerEmail({
    name: "<script>alert(1)</script>",
    sessionTitle: "<img src=x>",
    teacherName: "Teacher",
    when: "tomorrow",
    joinUrl: "javascript:alert(1)",
    locale: "en",
  });

  assert.doesNotMatch(email.html, /<script>/);
  assert.doesNotMatch(email.html, /<img/);
  assert.doesNotMatch(email.html, /javascript:/i);
});

test("password reset and reminder templates support both delivery languages", () => {
  const reset = passwordResetEmail({ code: "123456", locale: "ar" });
  const reminder = reminderEmail({
    role: "learner",
    kind: "1h",
    name: "ليلى",
    sessionTitle: "Speaking practice",
    teacherName: "Coach",
    when: "اليوم ٦:٠٠ م",
    timeUntil: "ساعة",
    joinUrl: "https://app.speexify.com/classroom/2",
    locale: "ar",
  });

  assert.match(reset.html, /dir="rtl"/);
  assert.match(reset.html, /رمز إعادة تعيين/);
  assert.match(reminder.html, /الحصة ستبدأ قريبًا/);
  assert.match(reminder.html, /dir="rtl"/);
});
