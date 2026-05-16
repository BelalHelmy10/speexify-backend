// src/lib/notificationPreferences.js
import { prisma } from "./prisma.js";

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  emailSessionReminders: true,
  emailSessionChanges: true,
  inAppSessionReminders: true,
  weeklyProgressDigest: true,
  productUpdates: false,
  reminderLeadTime: "24h",
});

const REMINDER_TYPES = new Set(["reminder_24h", "reminder_6h", "reminder_1h"]);
const SESSION_CHANGE_TYPES = new Set([
  "booking_confirmed",
  "new_booking",
  "session_canceled",
]);
const PROGRESS_TYPES = new Set(["session_completed", "feedback_received"]);

export async function getNotificationPreferences(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });

  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(user?.notificationPreferences || {}),
  };
}

/**
 * Whether an in-app notification should be created for this user + type.
 */
export async function shouldDeliverInAppNotification(userId, type) {
  const prefs = await getNotificationPreferences(userId);
  const normalized = String(type || "");

  if (REMINDER_TYPES.has(normalized)) {
    if (!prefs.inAppSessionReminders) return false;
    if (prefs.reminderLeadTime === "none") return false;

    const lead = prefs.reminderLeadTime;
    if (lead === "24h" && normalized !== "reminder_24h") return false;
    if (lead === "6h" && normalized !== "reminder_6h") return false;
    if (lead === "1h" && normalized !== "reminder_1h") return false;
    return true;
  }

  if (SESSION_CHANGE_TYPES.has(normalized)) {
    return prefs.emailSessionChanges !== false;
  }

  if (PROGRESS_TYPES.has(normalized)) {
    return prefs.weeklyProgressDigest !== false;
  }

  if (normalized === "payment_receipt") return true;
  if (normalized === "test") return true;
  if (normalized.startsWith("product_")) return prefs.productUpdates === true;

  return true;
}
