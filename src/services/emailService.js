// src/services/emailService.js
import nodemailer from "nodemailer";
import { logger } from "../lib/logger.js";

const EMAIL_FROM =
  process.env.EMAIL_FROM || "Speexify <no-reply@speexify.local>";

const hasSMTP =
  !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;

let transporter = null;

if (hasSMTP) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  transporter
    .verify()
    .then(() => logger.info({}, "📧 SMTP transporter ready (shared)"))
    .catch((err) => {
      logger.warn(
        { err },
        "⚠️  SMTP verify failed. Falling back to console email."
      );
      transporter = null;
    });
}

export async function sendEmail(to, subject, html) {
  if (!transporter) {
    logger.info({ to, subject, html }, "[DEV EMAIL] Outgoing email (DEV mode)");
    return;
  }
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, html });
}
