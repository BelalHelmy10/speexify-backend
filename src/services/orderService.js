import { fulfillmentTerms } from "./packageEntitlements.js";
// src/services/orderService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { createNotification } from "./notificationsService.js";
import { enqueueEmail } from "./emailService.js";
import {
    ADMIN_ALERT_TYPES,
    notifyAdmins,
} from "./adminAlertsService.js";

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
}

function formatMoney(amountCents, currency) {
    const amount = Number(amountCents || 0) / 100;
    try {
        return new Intl.NumberFormat("en", {
            style: "currency",
            currency: String(currency || "EGP").toUpperCase(),
        }).format(amount);
    } catch {
        return `${amount.toFixed(2)} ${String(currency || "EGP").toUpperCase()}`;
    }
}

function frontendBaseUrl() {
    return String(process.env.FRONTEND_URL || "https://speexify.com").replace(/\/$/, "");
}

async function sendPaidOrderNotifications(result) {
    const order = result?.order;
    if (!order?.id || !order.userId) return;

    let user = null;
    let pkg = null;
    try {
        [user, pkg] = await Promise.all([
            prisma.user.findUnique({
                where: { id: order.userId },
                select: { id: true, name: true, email: true, language: true },
            }),
            prisma.package.findUnique({
                where: { id: order.packageId },
                select: { id: true, title: true },
            }),
        ]);
    } catch (error) {
        logger.error({ err: error, orderId: order.id }, "payment receipt recipient lookup failed");
    }

    const packageTitle = result.userPackage?.title || pkg?.title || "Speexify package";
    const amount = formatMoney(order.amountCents, order.currency);

    if (user) {
        try {
            const [existingNotification, existingDelivery] = await Promise.all([
                prisma.notification.findFirst({
                    where: {
                        userId: order.userId,
                        type: "payment_receipt",
                        data: { path: ["orderId"], equals: order.id },
                    },
                    select: { id: true },
                }),
                prisma.notificationDelivery.findFirst({
                    where: {
                        userId: order.userId,
                        eventType: `payment_receipt:${order.id}`,
                    },
                    select: { id: true },
                }),
            ]);
            let notification = existingNotification;
            if (!notification) {
                notification = await createNotification({
                    userId: user.id,
                    type: "payment_receipt",
                    title: "Payment received",
                    body: `${packageTitle} is active with ${result.userPackage?.sessionsTotal || 0} session credit(s).`,
                    data: {
                        orderId: order.id,
                        packageId: order.packageId,
                        userPackageId: result.userPackage?.id || null,
                        amountCents: order.amountCents,
                        currency: order.currency,
                    },
                    skipPreferenceCheck: true,
                    skipDedup: true,
                });
            }
            if (!existingDelivery && user.email) {
                await enqueueEmail(
                    user.email,
                    `Payment received · ${packageTitle}`,
                    `<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6;color:#172033"><h2>Payment received</h2><p>Hello ${escapeHtml(user.name || "there")},</p><p>Your payment of <strong>${escapeHtml(amount)}</strong> was confirmed.</p><p><strong>${escapeHtml(packageTitle)}</strong> is now active with ${Number(result.userPackage?.sessionsTotal || 0)} session credit(s).</p><p><a href="${escapeHtml(`${frontendBaseUrl()}/dashboard`)}">View your package</a></p></div>`,
                    {
                        userId: user.id,
                        notificationId: notification?.id || null,
                        eventType: `payment_receipt:${order.id}`,
                        locale: user.language || "en",
                    }
                );
            }
        } catch (error) {
            logger.error({ err: error, orderId: order.id }, "learner payment receipt delivery failed");
        }
    }

    try {
        await notifyAdmins({
            type: ADMIN_ALERT_TYPES.PAYMENT_SUCCEEDED,
            title: "Payment confirmed and credits granted",
            body: `${user?.name || user?.email || `Learner #${order.userId}`} purchased ${packageTitle} for ${amount}.`,
            severity: "success",
            adminPath: `/admin?section=payments&orderId=${encodeURIComponent(order.id)}`,
            data: {
                orderId: order.id,
                userId: order.userId,
                packageId: order.packageId,
                userPackageId: result.userPackage?.id || null,
            },
            dedupeKey: `payment-paid:${order.id}`,
            dedupeWindowMs: null,
            email: "none",
        });
    } catch (error) {
        logger.error({ err: error, orderId: order.id }, "admin paid-order alert failed");
    }
}

/*
 * Keep the implementation below this point focused on order state. Receipt
 * delivery is deliberately isolated above so a transient notification failure
 * can never turn a successfully fulfilled payment into a failed webhook.
 */

/**
 * Create a pending order when user initiates payment
 */
export async function createPendingOrder({
    orderId,
    userId,
    packageId,
    amountCents,
    currency = "EGP",
    displayAmountCents,
    displayCurrency,
    pricingSnapshot,
    customerEmail,
    customerPhone,
    discountCodeId,
}) {
    try {
        const order = await prisma.order.create({
            data: {
                id: orderId,
                userId: Number(userId),
                packageId: Number(packageId),
                amountCents: Number(amountCents),
                currency,
                status: "pending",
                pricingSnapshot,
                psp: "paymob",
                customerEmail,
                customerPhone,
                discountCodeId: discountCodeId ? Number(discountCodeId) : null,
            },
        });

        logger.info(
            { orderId, userId, packageId, amountCents, displayAmountCents, displayCurrency },
            "Order created with pending status"
        );

        return order;
    } catch (error) {
        logger.error({ error, orderId }, "Failed to create pending order");
        throw error;
    }
}

/**
 * Mark order as paid and grant credits
 */
export async function markOrderPaid(orderId, paymobTxnId) {
    try {
        const result = await prisma.$transaction(async (tx) => {
            let order = await tx.order.findUnique({
                where: { id: orderId },
                include: { userPackage: true },
            });

            if (!order) {
                throw new Error(`Order not found: ${orderId}`);
            }

            if (order.status !== "paid") {
                await tx.order.update({
                    where: { id: orderId },
                    data: {
                        status: "paid",
                        paymobTxnId: paymobTxnId ? Number(paymobTxnId) : null,
                        updatedAt: new Date(),
                    },
                });

                order = await tx.order.findUnique({
                    where: { id: orderId },
                    include: { userPackage: true },
                });

                if (!order) {
                    throw new Error(`Order disappeared while marking paid: ${orderId}`);
                }
            }

            if (order.userPackage) {
                logger.warn(
                    { orderId },
                    "UserPackage already exists for this order, skipping credit grant"
                );
                return { order, userPackage: order.userPackage, alreadyGranted: true };
            }

            if (!order.packageId || !order.userId) {
                throw new Error(`Order is missing packageId/userId: ${orderId}`);
            }

            const pkg = await tx.package.findUnique({
                where: { id: order.packageId },
            });

            if (!pkg) {
                throw new Error(`Package not found: ${order.packageId}`);
            }

            const terms = fulfillmentTerms(order, pkg);
            try {
                const userPackage = await tx.userPackage.create({
                    data: {
                        userId: order.userId,
                        packageId: order.packageId,
                        orderId: order.id,
                        title: terms.title,
                        lessonType: terms.lessonType ?? pkg.lessonType ?? null,
                        minutesPerSession: terms.minutesPerSession,
                        sessionsTotal: terms.sessionsTotal,
                        sessionsUsed: 0,
                        status: "active",
                        expiresAt: terms.validityDays
                            ? new Date(Date.now() + terms.validityDays * 24 * 60 * 60 * 1000)
                            : null,
                    },
                });

                return { order, userPackage, alreadyGranted: false };
            } catch (error) {
                if (error?.code === "P2002") {
                    const existingUserPackage = await tx.userPackage.findUnique({
                        where: { orderId: order.id },
                    });
                    if (existingUserPackage) {
                        logger.warn(
                            { orderId },
                            "UserPackage already created concurrently for paid order"
                        );
                        return {
                            order,
                            userPackage: existingUserPackage,
                            alreadyGranted: true,
                        };
                    }
                }
                throw error;
            }
        });

        logger.info(
            { orderId, paymobTxnId, alreadyGranted: result.alreadyGranted },
            "Order marked as paid"
        );
        await sendPaidOrderNotifications(result);
        return result;
    } catch (error) {
        logger.error({ error, orderId }, "Failed to mark order as paid");
        throw error;
    }
}

/**
 * Mark order as failed
 */
export async function markOrderFailed(orderId, reason) {
    try {
        const updated = await prisma.order.updateMany({
            where: {
                id: orderId,
                status: { not: "paid" },
            },
            data: {
                status: "failed",
                updatedAt: new Date(),
            },
        });

        const order = await prisma.order.findUnique({
            where: { id: orderId },
        });

        if (!order) {
            throw new Error(`Order not found: ${orderId}`);
        }

        if (updated.count === 0 && order.status === "paid") {
            logger.warn(
                { orderId, reason },
                "Skipping failure transition because order is already paid"
            );
            return { order, skipped: true };
        }

        logger.info({ orderId, reason }, "Order marked as failed");

        if (updated.count > 0) {
            await notifyAdmins({
                type: ADMIN_ALERT_TYPES.PAYMENT_ATTENTION,
                title: "Payment failed",
                body: `Order ${orderId} failed (${reason || "provider declined"}).`,
                severity: "warning",
                adminPath: `/admin?section=payments&orderId=${encodeURIComponent(orderId)}`,
                data: { orderId, userId: order.userId, packageId: order.packageId, reason },
                dedupeKey: `payment-failed:${orderId}:${order.updatedAt?.toISOString?.() || "latest"}`,
                email: "critical",
            });
        }

        return { order, skipped: false };
    } catch (error) {
        logger.error({ error, orderId, reason }, "Failed to mark order as failed");
        throw error;
    }
}

/**
 * Move an unpaid order back to pending so the user can retry checkout safely.
 */
export async function markOrderPendingForRetry(orderId, reason = "retry_requested") {
    try {
        const updated = await prisma.order.updateMany({
            where: {
                id: orderId,
                status: { not: "paid" },
            },
            data: {
                status: "pending",
                updatedAt: new Date(),
            },
        });

        const order = await prisma.order.findUnique({
            where: { id: orderId },
        });

        if (!order) {
            throw new Error(`Order not found: ${orderId}`);
        }

        if (updated.count === 0 && order.status === "paid") {
            logger.warn(
                { orderId, reason },
                "Skipping retry transition because order is already paid"
            );
            return { order, skipped: true };
        }

        logger.info({ orderId, reason }, "Order reset to pending for retry");
        return { order, skipped: false };
    } catch (error) {
        logger.error({ error, orderId, reason }, "Failed to reset order for retry");
        throw error;
    }
}

/**
 * Get order by merchant order ID (our orderId)
 */
export async function getOrderById(orderId) {
    try {
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: {
                userPackage: {
                    select: {
                        id: true,
                        title: true,
                        sessionsTotal: true,
                        sessionsUsed: true,
                        status: true,
                    },
                },
            },
        });

        return order;
    } catch (error) {
        logger.error({ error, orderId }, "Failed to get order");
        throw error;
    }
}

/**
 * Create UserPackage (grant credits) from a paid order
 */
export async function grantPackageCredits(order) {
    try {
        // Fetch the package details
        const pkg = await prisma.package.findUnique({
            where: { id: order.packageId },
        });

        if (!pkg) {
            throw new Error(`Package not found: ${order.packageId}`);
        }

        const terms = fulfillmentTerms(order, pkg);

        // Create UserPackage with credits
        const userPackage = await prisma.userPackage.create({
            data: {
                userId: order.userId,
                packageId: order.packageId,
                orderId: order.id,
                title: terms.title,
                        lessonType: terms.lessonType ?? pkg.lessonType ?? null,
                minutesPerSession: terms.minutesPerSession,
                sessionsTotal: terms.sessionsTotal,
                sessionsUsed: 0,
                status: "active",
                expiresAt: terms.validityDays
                    ? new Date(Date.now() + terms.validityDays * 24 * 60 * 60 * 1000)
                    : null,
            },
        });

        logger.info(
            {
                orderId: order.id,
                userId: order.userId,
                packageId: order.packageId,
                userPackageId: userPackage.id,
                sessionsTotal: userPackage.sessionsTotal,
            },
            "UserPackage created - credits granted"
        );

        return userPackage;
    } catch (error) {
        logger.error({ error, orderId: order.id }, "Failed to grant package credits");
        throw error;
    }
}

/**
 * Check if order already exists (for idempotency)
 */
export async function orderExists(orderId) {
    const count = await prisma.order.count({ where: { id: orderId } });
    return count > 0;
}
