// src/services/emailService.js
import axios from "axios";
import { logger } from "../lib/logger.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM =
  process.env.EMAIL_FROM || "Speexify <no-reply@mail.speexify.com>";

function parseFromHeader(from) {
  let name = "Speexify";
  let email = String(from || "").trim();

  const match = email.match(/^(.*)<(.+@.+)>$/);
  if (match) {
    name = match[1].trim().replace(/^"|"$/g, "") || "Speexify";
    email = match[2].trim();
  }

  return { name, email };
}

function normalizeRecipients(to) {
  // supports: string, array of strings, {email, name}, array of {email, name}
  if (!to) return [];

  const arr = Array.isArray(to) ? to : [to];

  return arr
    .map((item) => {
      if (!item) return null;

      if (typeof item === "string") {
        return { email: item.trim() };
      }

      if (typeof item === "object" && item.email) {
        return { email: String(item.email).trim(), name: item.name?.trim() };
      }

      return null;
    })
    .filter(Boolean);
}

/**
 * sendEmail(to, subject, html)
 * - Uses Resend API
 * - If RESEND_API_KEY missing -> logs and returns (safe dev mode)
 */
export async function sendEmail(to, subject, html) {
  const toList = normalizeRecipients(to);

  if (!toList.length) {
    logger.warn({ to, subject }, "sendEmail called with no valid recipients");
    return;
  }

  if (!RESEND_API_KEY) {
    logger.info(
      { to: toList, subject },
      "[DEV EMAIL] Email NOT SENT — RESEND_API_KEY is missing."
    );
    return;
  }

  const { name, email } = parseFromHeader(EMAIL_FROM);

  const payload = {
    from: name ? `${name} <${email}>` : email,
    to: toList.map((r) => r.email),
    subject: String(subject || ""),
    html: String(html || ""),
  };

  try {
    await axios.post("https://api.resend.com/emails", payload, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    logger.info({ to: toList, subject }, "📧 Email sent via Resend");
  } catch (err) {
    logger.error(
      {
        to: toList,
        subject,
        message: err.message,
        status: err.response?.status,
        responseData: err.response?.data,
      },
      "❌ Failed to send email via Resend"
    );
    throw err;
  }
}
