import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { enqueueEmail } from "./emailService.js";
import { adminNewRegistrationEmail } from "./emailTemplates.js";
import { createNotification } from "./notificationsService.js";

function getAdminNotificationEmail() {
  return process.env.ADMIN_NOTIFICATION_EMAIL || "support@speexify.com";
}

function getAdminBaseUrl() {
  return (
    process.env.ADMIN_APP_URL ||
    process.env.FRONTEND_URL ||
    "https://speexify.com"
  ).replace(/\/$/, "");
}

function registrationProfileUrl(userId) {
  return `${getAdminBaseUrl()}/admin/registrations/${encodeURIComponent(String(userId))}`;
}

async function createAdminRegistrationNotification(adminId, user, source) {
  const existing = await prisma.notification.findFirst({
    where: {
      userId: adminId,
      type: "user_registered",
      data: {
        path: ["registrationUserId"],
        equals: user.id,
      },
    },
    orderBy: { id: "desc" },
    select: { id: true },
  });

  if (existing) return existing;

  return createNotification({
    userId: adminId,
    type: "user_registered",
    title: "New learner joined Speexify",
    body: `${user.name || user.email} created an account.`,
    data: {
      registrationUserId: user.id,
      email: user.email,
      name: user.name || null,
      source,
      createdAt: user.createdAt
        ? new Date(user.createdAt).toISOString()
        : new Date().toISOString(),
    },
    skipPreferenceCheck: true,
    skipDedup: true,
  });
}

/**
 * Notify active admins about a newly registered learner.
 * Registration must never fail because an admin alert is temporarily
 * unavailable, so each delivery is isolated and logged.
 */
export async function notifyNewRegistration({ user, source = "email" }) {
  if (!user?.id || !user?.email) return { adminsNotified: 0, emailQueued: false };

  try {
    const admins = await prisma.user.findMany({
      where: { role: "admin", isDisabled: false },
      select: { id: true },
    });

    const email = adminNewRegistrationEmail({
      user,
      source,
      adminUrl: registrationProfileUrl(user.id),
    });

    const results = await Promise.allSettled([
      ...admins.map((admin) =>
        createAdminRegistrationNotification(admin.id, user, source)
      ),
      enqueueEmail(
        getAdminNotificationEmail(),
        email.subject,
        email.html,
        {
          userId: user.id,
          eventType: "new_registration",
          locale: "en",
        }
      ),
    ]);

    const adminsNotified = results
      .slice(0, admins.length)
      .filter((result) => result.status === "fulfilled" && result.value)
      .length;
    const emailQueued = results[admins.length]?.status === "fulfilled";

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.error(
          { err: result.reason, userId: user.id, adminIndex: index },
          "[registration] admin notification delivery failed"
        );
      }
    });

    return { adminsNotified, emailQueued };
  } catch (err) {
    logger.error(
      { err, userId: user.id },
      "[registration] failed to prepare admin notifications"
    );
    return { adminsNotified: 0, emailQueued: false };
  }
}
