// api/scripts/sendReminders24h.js
import "dotenv/config";
import nodemailer from "nodemailer";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Use your existing SMTP envs
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const fmtInTz = (date, tz) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "UTC",
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);

async function main() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // Find sessions starting ~24 hours from now, not yet reminded
  const sessions = await prisma.session.findMany({
    where: {
      startAt: { gte: in24h, lt: in25h },
      reminder24hSentAt: null,
    },
    include: { user: true },
  });

  for (const s of sessions) {
    const when = fmtInTz(s.startAt, s.user?.timezone);
    const to = s.user?.email;
    const subject = `Reminder: ${s.title || "Coaching Session"} – ${when}`;
    const lines = [
      `Hi ${s.user?.name || "there"},`,
      ``,
      `This is a quick reminder for your session:`,
      `Title: ${s.title || "Coaching Session"}`,
      `When: ${when} (${s.user?.timezone || "UTC"})`,
      s.meetingUrl ? `Join: ${s.meetingUrl}` : null,
      s.notes ? `Notes: ${s.notes}` : null,
      ``,
      `See you soon!`,
      `— Speexify`,
    ].filter(Boolean);

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text: lines.join("\n"),
    });

    // Mark as sent so we don't resend next time
    await prisma.session.update({
      where: { id: s.id },
      data: { reminder24hSentAt: new Date() },
    });

    console.log(`✔ sent 24h reminder to ${to} for session ${s.id}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
