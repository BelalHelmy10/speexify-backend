const COPY = {
  en: {
    team: "The Speexify Team",
    hi: "Hi",
    bookingLearnerSubject: "Speexify — Lesson Confirmed! 🎉",
    bookingLearnerTitle: "🎉 Lesson Confirmed!",
    bookingLearnerIntro: "Great news! Your lesson has been successfully booked.",
    bookingTeacherSubject: "Speexify — New Lesson Booked",
    bookingTeacherTitle: "📅 New Lesson Booked",
    bookingTeacherIntro: "A new lesson has been scheduled with you.",
    session: "Session",
    teacher: "Teacher",
    learner: "Learner",
    learners: "Learners",
    when: "When",
    scheduledFor: "Was scheduled for",
    joinClassroom: "Join your classroom",
    viewSession: "View Session Details",
    bookingLearnerNote: "You'll receive reminder emails before your session starts.",
    sessionUpdatedSubject: "Speexify — Session Time Updated",
    sessionUpdatedTitle: "🕒 Session Time Updated",
    sessionUpdatedLearnerIntro: "The time of your session has been updated.",
    sessionUpdatedTeacherIntro: "The time of a session on your schedule has been updated.",
    previousTime: "Previous time",
    newTime: "New time",
    sessionUpdatedNote: "Please use the new time below. Your session details remain unchanged.",
    canceledSubject: "Speexify — Session Canceled",
    canceledTitle: "❌ Session Canceled",
    canceledIntro: "Unfortunately, your session has been canceled.",
    refund: "✅ Your credit has been refunded.",
    canceledLearnerNote: "We apologize for any inconvenience. You can book a new session anytime from your dashboard.",
    canceledTeacherIntro: "A session has been canceled",
    canceledTeacherNote: "Your schedule has been updated automatically.",
    byAdmin: "by an administrator",
    byLearner: "by the learner",
    feedbackSubject: (teacher) => `Speexify — ${teacher} left you feedback! 💬`,
    feedbackTitle: "💬 New Feedback Received!",
    feedbackIntro: (teacher, session) => `${teacher} has left feedback for your session “${session}”.`,
    messageFrom: (teacher) => `Message from ${teacher}:`,
    viewDashboard: "View in Dashboard",
    feedbackNote: "Log in and go to your past sessions to view the full feedback.",
    feedbackTip: "💡 Reviewing feedback helps you track your progress and prepare for future sessions.",
    reminderTitle: { "24h": "Session reminder (tomorrow)", "6h": "Session reminder (today)", "1h": "Session starting soon!" },
    reminderSubject: (title) => `Speexify — ${title}`,
    reminderLearnerIntro: (time) => `Your session is coming up in ${time}!`,
    reminderReady: "⚡ Your session starts very soon. Please be ready!",
    reminderPrepare: "💡 Make sure to prepare any questions or materials before the session.",
    startSession: "Start Session",
    verificationSubject: "Your Speexify verification code",
    verificationIntro: "Your verification code is:",
    resetSubject: "Your Speexify password reset code",
    resetIntro: "Use this code to reset your password:",
    codeExpiry: "This code expires in 10 minutes.",
  },
  ar: {
    team: "فريق Speexify",
    hi: "مرحبًا",
    bookingLearnerSubject: "Speexify — تم تأكيد الحصة! 🎉",
    bookingLearnerTitle: "🎉 تم تأكيد الحصة!",
    bookingLearnerIntro: "خبر رائع! تم حجز حصتك بنجاح.",
    bookingTeacherSubject: "Speexify — تم حجز حصة جديدة",
    bookingTeacherTitle: "📅 تم حجز حصة جديدة",
    bookingTeacherIntro: "تم جدولة حصة جديدة معك.",
    session: "الحصة",
    teacher: "المدرب",
    learner: "المتعلم",
    learners: "المتعلمون",
    when: "الموعد",
    scheduledFor: "كان موعدها",
    joinClassroom: "ادخل إلى الفصل",
    viewSession: "عرض تفاصيل الحصة",
    bookingLearnerNote: "ستصلك رسائل تذكير قبل بدء الحصة.",
    sessionUpdatedSubject: "Speexify — تم تحديث موعد الحصة",
    sessionUpdatedTitle: "🕒 تم تحديث موعد الحصة",
    sessionUpdatedLearnerIntro: "تم تحديث موعد حصتك.",
    sessionUpdatedTeacherIntro: "تم تحديث موعد حصة في جدولك.",
    previousTime: "الموعد السابق",
    newTime: "الموعد الجديد",
    sessionUpdatedNote: "يرجى اعتماد الموعد الجديد أدناه. تفاصيل الحصة الأخرى لم تتغير.",
    canceledSubject: "Speexify — تم إلغاء الحصة",
    canceledTitle: "❌ تم إلغاء الحصة",
    canceledIntro: "للأسف، تم إلغاء حصتك.",
    refund: "✅ تمت إعادة الرصيد إلى حسابك.",
    canceledLearnerNote: "نعتذر عن أي إزعاج. يمكنك حجز حصة جديدة من لوحة التحكم في أي وقت.",
    canceledTeacherIntro: "تم إلغاء حصة",
    canceledTeacherNote: "تم تحديث جدولك تلقائيًا.",
    byAdmin: "بواسطة الإدارة",
    byLearner: "بواسطة المتعلم",
    feedbackSubject: (teacher) => `Speexify — ${teacher} أرسل لك ملاحظات! 💬`,
    feedbackTitle: "💬 وصلتك ملاحظات جديدة!",
    feedbackIntro: (teacher, session) => `${teacher} أرسل ملاحظات عن حصتك “${session}”.`,
    messageFrom: (teacher) => `رسالة من ${teacher}:`,
    viewDashboard: "عرضها في لوحة التحكم",
    feedbackNote: "سجّل الدخول وافتح جلساتك السابقة لعرض الملاحظات كاملة.",
    feedbackTip: "💡 مراجعة الملاحظات تساعدك على متابعة تقدمك والاستعداد للحصص القادمة.",
    reminderTitle: { "24h": "تذكير بالحصة (غدًا)", "6h": "تذكير بالحصة (اليوم)", "1h": "الحصة ستبدأ قريبًا!" },
    reminderSubject: (title) => `Speexify — ${title}`,
    reminderLearnerIntro: (time) => `موعد حصتك سيبدأ خلال ${time}!`,
    reminderReady: "⚡ ستبدأ حصتك قريبًا جدًا. كن مستعدًا!",
    reminderPrepare: "💡 جهّز أي أسئلة أو مواد تحتاجها قبل الحصة.",
    startSession: "ابدأ الحصة",
    verificationSubject: "رمز تأكيد Speexify",
    verificationIntro: "رمز التأكيد الخاص بك:",
    resetSubject: "رمز إعادة تعيين كلمة مرور Speexify",
    resetIntro: "استخدم هذا الرمز لإعادة تعيين كلمة المرور:",
    codeExpiry: "ينتهي هذا الرمز خلال 10 دقائق.",
  },
};

const FALLBACK_EMAIL_TIMEZONE = "Africa/Cairo";

function resolveEmailTimeZone(timeZone) {
  const candidate = String(timeZone || "").trim() || FALLBACK_EMAIL_TIMEZONE;

  try {
    Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return FALLBACK_EMAIL_TIMEZONE;
  }
}

export function normalizeEmailLocale(value) {
  return String(value || "").toLowerCase().startsWith("ar") ? "ar" : "en";
}

export function emailCopy(locale, key, ...args) {
  const value = COPY[normalizeEmailLocale(locale)][key];
  return typeof value === "function" ? value(...args) : value ?? key;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeHref(value) {
  const url = String(value || "");
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "";
}

export function formatEmailDate(date, timeZone, locale) {
  try {
    return new Intl.DateTimeFormat(normalizeEmailLocale(locale) === "ar" ? "ar-EG" : "en-US", {
      timeZone: resolveEmailTimeZone(timeZone),
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

export function formatEmailTimeUntil(startAt, locale = "en") {
  const diffMs = new Date(startAt).getTime() - Date.now();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.max(0, Math.floor((diffMs % (1000 * 60 * 60)) / 60000));
  const l = normalizeEmailLocale(locale);
  if (diffHours > 24) {
    const count = Math.floor(diffHours / 24);
    return l === "ar" ? `${count} ${count === 1 ? "يوم" : "أيام"}` : `${count} day${count === 1 ? "" : "s"}`;
  }
  if (diffHours > 0) return l === "ar" ? `${diffHours} ${diffHours === 1 ? "ساعة" : "ساعات"}` : `${diffHours} hour${diffHours === 1 ? "" : "s"}`;
  return l === "ar" ? `${diffMinutes} ${diffMinutes === 1 ? "دقيقة" : "دقائق"}` : `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"}`;
}

export function withEmailDirection(html, locale = "en") {
  const lang = normalizeEmailLocale(locale);
  if (/\blang=["']/.test(String(html))) return String(html);
  return `<div lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"
    style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;text-align:${lang === "ar" ? "right" : "left"};">${html}</div>`;
}

function layout(locale, title, body, color = "#1a1a1a") {
  return withEmailDirection(`
    <h2 style="color:${color};">${title}</h2>
    ${body}
    <p style="margin-top:30px;">— ${emailCopy(locale, "team")}</p>
  `, locale);
}

export function verificationEmail({ code, locale = "en" }) {
  return {
    subject: emailCopy(locale, "verificationSubject"),
    html: layout(locale, emailCopy(locale, "verificationSubject"), `
      <p>${emailCopy(locale, "verificationIntro")}</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:2px;direction:ltr;">${escapeHtml(code)}</p>
      <p>${emailCopy(locale, "codeExpiry")}</p>
    `),
  };
}

/**
 * Internal admin alert for a newly created learner account.
 * Keep this separate from learner-facing copy so registration delivery is
 * explicit, auditable, and safe to send to the configured admin mailbox.
 */
export function adminNewRegistrationEmail({ user, source = "email", adminUrl }) {
  const name = user?.name || "New learner";
  const subjectName = String(name).replace(/[\r\n]+/g, " ").slice(0, 120);
  const profileUrl = safeHref(adminUrl);
  const joinedAt = formatEmailDate(
    user?.createdAt || new Date(),
    user?.timezone,
    "en"
  );
  const consent = user?.marketingPhoneConsentAt ? "Granted" : "Not granted";
  const rows = [
    ["Name", name],
    ["Email", user?.email || "Not provided"],
    ["Phone", user?.phone || "Not provided"],
    ["Registration source", source === "google" ? "Google sign-in" : "Email registration"],
    ["Joined", joinedAt],
    ["Language", user?.language || "en"],
    ["Timezone", user?.timezone || "Not set"],
    ["Marketing phone consent", consent],
  ];

  return {
    subject: `Speexify — New learner joined: ${subjectName}`,
    html: layout("en", "New learner joined Speexify", `
      <p>A new learner account was created on Speexify.</p>
      <div style="background:#fff7f2;border:1px solid #ffd8c7;border-radius:16px;padding:20px;margin:20px 0;">
        ${rows
          .map(
            ([label, value]) => `
              <p style="margin:0 0 10px;"><strong style="color:#0d1b2a;">${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>
            `
          )
          .join("")}
      </div>
      ${profileUrl ? `<p><a href="${profileUrl}" style="display:inline-block;background:#f25c2e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">View learner profile</a></p>` : ""}
    `, "#f25c2e"),
  };
}

export function passwordResetEmail({ code, locale = "en" }) {
  return {
    subject: emailCopy(locale, "resetSubject"),
    html: layout(locale, emailCopy(locale, "resetSubject"), `
      <p>${emailCopy(locale, "resetIntro")}</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:2px;direction:ltr;">${escapeHtml(code)}</p>
      <p>${emailCopy(locale, "codeExpiry")}</p>
    `),
  };
}

export function bookingLearnerEmail({ name, sessionTitle, teacherName, when, joinUrl, locale }) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "bookingLearnerSubject"),
    html: layout(l, emailCopy(l, "bookingLearnerTitle"), `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${emailCopy(l, "bookingLearnerIntro")}</p>
      <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin:20px 0;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>👨‍🏫 ${emailCopy(l, "teacher")}:</strong> ${escapeHtml(teacherName)}</p>
        <p><strong>📅 ${emailCopy(l, "when")}:</strong> ${escapeHtml(when)}</p>
      </div>
      ${safeHref(joinUrl) ? `<p><a href="${safeHref(joinUrl)}" style="display:inline-block;padding:12px 24px;background:#0066ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">${emailCopy(l, "joinClassroom")}</a></p>` : ""}
      <p style="color:#666;font-size:14px;margin-top:30px;">${emailCopy(l, "bookingLearnerNote")}</p>
    `),
  };
}

export function bookingTeacherEmail({ name, sessionTitle, learnerNames, learnerCount, when, joinUrl, locale }) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "bookingTeacherSubject"),
    html: layout(l, emailCopy(l, "bookingTeacherTitle"), `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${emailCopy(l, "bookingTeacherIntro")}</p>
      <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin:20px 0;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>👨‍🎓 ${learnerCount > 1 ? emailCopy(l, "learners") : emailCopy(l, "learner")}:</strong> ${escapeHtml(learnerNames)}</p>
        <p><strong>📅 ${emailCopy(l, "when")}:</strong> ${escapeHtml(when)}</p>
      </div>
      ${safeHref(joinUrl) ? `<p><a href="${safeHref(joinUrl)}" style="display:inline-block;padding:12px 24px;background:#0066ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">${emailCopy(l, "viewSession")}</a></p>` : ""}
    `),
  };
}

export function sessionUpdatedLearnerEmail({
  name,
  sessionTitle,
  teacherName,
  previousWhen,
  when,
  joinUrl,
  locale,
}) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "sessionUpdatedSubject"),
    html: layout(l, emailCopy(l, "sessionUpdatedTitle"), `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${emailCopy(l, "sessionUpdatedLearnerIntro")}</p>
      <div style="background:#fff7ed;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #f97316;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>👨‍🏫 ${emailCopy(l, "teacher")}:</strong> ${escapeHtml(teacherName)}</p>
        <p style="color:#64748b;"><strong>${emailCopy(l, "previousTime")}:</strong> ${escapeHtml(previousWhen)}</p>
        <p style="color:#c2410c;font-weight:700;"><strong>📅 ${emailCopy(l, "newTime")}:</strong> ${escapeHtml(when)}</p>
      </div>
      ${safeHref(joinUrl) ? `<p><a href="${safeHref(joinUrl)}" style="display:inline-block;padding:12px 24px;background:#0066ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">${emailCopy(l, "joinClassroom")}</a></p>` : ""}
      <p style="color:#64748b;font-size:14px;margin-top:30px;">${emailCopy(l, "sessionUpdatedNote")}</p>
    `, "#c2410c"),
  };
}

export function sessionUpdatedTeacherEmail({
  name,
  sessionTitle,
  learnerNames,
  learnerCount,
  previousWhen,
  when,
  joinUrl,
  locale,
}) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "sessionUpdatedSubject"),
    html: layout(l, emailCopy(l, "sessionUpdatedTitle"), `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${emailCopy(l, "sessionUpdatedTeacherIntro")}</p>
      <div style="background:#fff7ed;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #f97316;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>👨‍🎓 ${learnerCount > 1 ? emailCopy(l, "learners") : emailCopy(l, "learner")}:</strong> ${escapeHtml(learnerNames)}</p>
        <p style="color:#64748b;"><strong>${emailCopy(l, "previousTime")}:</strong> ${escapeHtml(previousWhen)}</p>
        <p style="color:#c2410c;font-weight:700;"><strong>📅 ${emailCopy(l, "newTime")}:</strong> ${escapeHtml(when)}</p>
      </div>
      ${safeHref(joinUrl) ? `<p><a href="${safeHref(joinUrl)}" style="display:inline-block;padding:12px 24px;background:#0066ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">${emailCopy(l, "viewSession")}</a></p>` : ""}
      <p style="color:#64748b;font-size:14px;margin-top:30px;">${emailCopy(l, "sessionUpdatedNote")}</p>
    `, "#c2410c"),
  };
}

export function cancellationLearnerEmail({ name, sessionTitle, when, refunded, locale }) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "canceledSubject"),
    html: layout(l, emailCopy(l, "canceledTitle"), `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${emailCopy(l, "canceledIntro")}</p>
      <div style="background:#fef2f2;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #dc2626;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>📅 ${emailCopy(l, "scheduledFor")}:</strong> ${escapeHtml(when)}</p>
      </div>
      ${refunded ? `<p style="color:#22c55e;font-weight:600;">${emailCopy(l, "refund")}</p>` : ""}
      <p>${emailCopy(l, "canceledLearnerNote")}</p>
    `, "#dc2626"),
  };
}

export function cancellationTeacherEmail({ name, sessionTitle, learnerNames, when, cancelInfo, locale }) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "canceledSubject"),
    html: layout(l, `📅 ${emailCopy(l, "canceledTitle").replace(/^❌\s*/, "")}`, `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${emailCopy(l, "canceledTeacherIntro")}${cancelInfo ? ` ${escapeHtml(cancelInfo)}` : ""}.</p>
      <div style="background:#fef2f2;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #dc2626;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>👨‍🎓 ${emailCopy(l, "learners")}:</strong> ${escapeHtml(learnerNames)}</p>
        <p><strong>📅 ${emailCopy(l, "scheduledFor")}:</strong> ${escapeHtml(when)}</p>
      </div>
      <p>${emailCopy(l, "canceledTeacherNote")}</p>
    `, "#dc2626"),
  };
}

export function feedbackEmail({ name, teacherName, sessionTitle, messagePreview, locale }) {
  const l = normalizeEmailLocale(locale);
  return {
    subject: emailCopy(l, "feedbackSubject", teacherName),
    html: layout(l, emailCopy(l, "feedbackTitle"), `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${escapeHtml(emailCopy(l, "feedbackIntro", teacherName, sessionTitle))}</p>
      ${messagePreview ? `<div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px;padding:16px;margin:20px 0;"><p style="font-weight:600;color:#166534;">${escapeHtml(emailCopy(l, "messageFrom", teacherName))}</p><p style="font-style:italic;">“${escapeHtml(messagePreview)}”</p></div>` : ""}
      <p><a href="https://app.speexify.com/dashboard" style="display:inline-block;padding:14px 28px;background:#0066ff;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">${emailCopy(l, "viewDashboard")}</a></p>
      <p style="color:#64748b;font-size:13px;">${emailCopy(l, "feedbackNote")}</p>
      <p style="color:#64748b;font-size:13px;">${emailCopy(l, "feedbackTip")}</p>
    `),
  };
}

export function reminderEmail({ role, kind, name, sessionTitle, teacherName, learnerNames, learnerCount, when, timeUntil, joinUrl, locale }) {
  const l = normalizeEmailLocale(locale);
  const title = emailCopy(l, "reminderTitle")[kind] || emailCopy(l, "reminderTitle")["24h"];
  const intro = emailCopy(l, "reminderLearnerIntro", timeUntil);
  const buttonLabel = role === "teacher" ? emailCopy(l, "startSession") : emailCopy(l, "joinClassroom");
  return {
    subject: emailCopy(l, "reminderSubject", title),
    html: layout(l, `${kind === "1h" ? "🚨" : kind === "6h" ? "⏰" : "📅"} ${title}`, `
      <p>${emailCopy(l, "hi")}${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>${intro}</p>
      <div style="background:${kind === "1h" ? "#fef3c7" : "#f8f9fa"};border-radius:12px;padding:20px;margin:20px 0;">
        <p><strong>📚 ${emailCopy(l, "session")}:</strong> ${escapeHtml(sessionTitle)}</p>
        <p><strong>${role === "teacher" ? "👨‍🎓" : "👨‍🏫"} ${role === "teacher" ? (learnerCount > 1 ? emailCopy(l, "learners") : emailCopy(l, "learner")) : emailCopy(l, "teacher")}:</strong> ${escapeHtml(role === "teacher" ? learnerNames : teacherName)}</p>
        <p><strong>📅 ${emailCopy(l, "when")}:</strong> ${escapeHtml(when)}</p>
      </div>
      ${safeHref(joinUrl) ? `<p><a href="${safeHref(joinUrl)}" style="display:inline-block;padding:14px 28px;background:#0066ff;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">${buttonLabel}</a></p>` : ""}
      <p style="color:#64748b;font-size:13px;">${kind === "1h" ? emailCopy(l, "reminderReady") : emailCopy(l, "reminderPrepare")}</p>
    `),
  };
}
