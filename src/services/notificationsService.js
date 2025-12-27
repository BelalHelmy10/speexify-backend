// src/services/notificationsService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Create an in-app notification for a user.
 * Keep this tiny and reusable so we can call it from booking/payment flows later.
 */
export async function createNotification({
  userId,
  type,
  title,
  body = null,
  data = null,
}) {
  if (!userId || !type || !title) {
    throw new Error("createNotification: userId, type, and title are required");
  }

  const notif = await prisma.notification.create({
    data: {
      userId,
      type: String(type),
      title: String(title),
      body: body ? String(body) : null,
      data,
    },
  });

  logger.info(
    { userId, notificationId: notif.id, type: notif.type },
    "notification created"
  );

  return notif;
}
