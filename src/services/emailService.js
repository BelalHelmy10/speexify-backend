// src/services/emailService.js
import axios from "axios";
import { logger } from "../lib/logger.js";

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "Speexify <no-reply@speexify.com>";

const isProd = process.env.NODE_ENV === "production";

// Helper to split "Name <email@domain.com>" into { name, email }
function parseFromHeader(from) {
  let name = "Speexify";
  let email = from.trim();

  const match = from.match(/^(.*)<(.+@.+)>$/);
  if (match) {
    name = match[1].trim().replace(/^"|"$/g, "") || "Speexify";
    email = match[2].trim();
  }

  return { name, email };
}

export async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) {
    logger.info(
      { to, subject },
      "[DEV EMAIL] Email NOT SENT — BREVO_API_KEY is missing."
    );
    return;
  }

  const { name, email } = parseFromHeader(EMAIL_FROM);

  const payload = {
    sender: {
      email,
      name,
    },
    to: [{ email: String(to).trim() }],
    subject,
    htmlContent: html,
  };

  try {
    await axios.post("https://api.brevo.com/v3/smtp/email", payload, {
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      timeout: 10000,
    });

    logger.info({ to, subject }, "📧 Email sent via Brevo HTTP API");
  } catch (err) {
    logger.error(
      { err, to, subject },
      "❌ Failed to send email via Brevo HTTP API"
    );
    // Let the caller decide what to do
    throw err;
  }
}
