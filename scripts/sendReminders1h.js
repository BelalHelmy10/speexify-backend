// api/scripts/sendReminders1h.js
import "dotenv/config";
import nodemailer from "nodemailer";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

  // real window: 60–70 minutes from now
  let in1h = new Date(now.getTime() + 60 * 60 * 1000);
  let in70m = new Date(now.getTime() + 70 * 60 * 1000);

  // --- QUICK TEST MODE (uncomment while testing) ---
  // in1h = new Date(now.getTime() + 1 * 60 * 1000); // 1 minute
  // in70m = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes
  // --------------------------------------------------

  const sessions = await prisma.session.findMany({
    where: {
      startAt: { gte: in1h, lt: in70m },
      reminder1hSentAt: null,
    },
    include: { user: true },
  });

  for (const s of sessions) {
    const to = process.env.TEST_EMAIL || s.user?.email;
    const when = fmtInTz(s.startAt, s.user?.timezone);
    const subject = `Starting in ~1 hour: ${s.title || "Session"} – ${when}`;
    const lines = [
      `Hi ${s.user?.name || "there"},`,
      ``,
      `Your session starts in about one hour:`,
      `Title: ${s.title || "Session"}`,
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

    await prisma.session.update({
      where: { id: s.id },
      data: { reminder1hSentAt: new Date() },
    });

    console.log(`✔ sent 1h reminder to ${to} for session ${s.id}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
