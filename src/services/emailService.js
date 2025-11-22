// src/services/emailService.js
import nodemailer from "nodemailer";
import { logger } from "../lib/logger.js";
import { isProd } from "../config/env.js";

/**
 * Required environment variables:
 *  - SMTP_HOST
 *  - SMTP_PORT
 *  - SMTP_USER
 *  - SMTP_PASS
 *  - EMAIL_FROM   (e.g. "Speexify <hello@speexify.com>")
 */

const EMAIL_FROM =
  process.env.EMAIL_FROM || "Speexify <no-reply@speexify.local>";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const smtpConfigured =
  Boolean(SMTP_HOST) &&
  Boolean(SMTP_USER) &&
  Boolean(SMTP_PASS) &&
  Boolean(EMAIL_FROM);

let transporter = null;

if (smtpConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // secure for port 465
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  transporter
    .verify()
    .then(() =>
      logger.info("📧 SMTP transport verified — real emails will be sent.")
    )
    .catch((err) => {
      logger.error({ err }, "❌ SMTP verification failed — falling back.");
      transporter = null;
    });
} else {
  logger.warn(
    {
      SMTP_HOST: !!SMTP_HOST,
      SMTP_USER: !!SMTP_USER,
      SMTP_PASS: !!SMTP_PASS,
      EMAIL_FROM: !!EMAIL_FROM,
    },
    "⚠️ SMTP not fully configured — will NOT send real emails."
  );
}

/**
 * Email sending function.
 *
 * In PRODUCTION:
 *   - Uses SMTP and sends real emails.
 *
 * In DEVELOPMENT or if SMTP is not configured:
 *   - Logs the email to console.
 */
export async function sendEmail(to, subject, html) {
  // If no transporter or not prod, just log it (no real send)
  if (!transporter || !isProd) {
    logger.info(
      { to, subject },
      "[DEV EMAIL] Email NOT SENT — SMTP disabled or not in production."
    );
    logger.debug({ html }, "[DEV EMAIL BODY]");
    return;
  }

  try {
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      html,
    });

    logger.info(
      {
        to,
        subject,
        messageId: info.messageId,
      },
      "📧 Email sent successfully"
    );
  } catch (err) {
    logger.error({ err, to, subject }, "❌ Failed to send email");
    throw err; // IMPORTANT — allows route to show an error instead of fake success
  }
}
