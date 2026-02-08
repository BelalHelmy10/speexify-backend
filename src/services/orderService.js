// src/services/orderService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

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

            try {
                const userPackage = await tx.userPackage.create({
                    data: {
                        userId: order.userId,
                        packageId: order.packageId,
                        orderId: order.id,
                        title: pkg.title,
                        minutesPerSession: pkg.durationMin || null,
                        sessionsTotal: pkg.sessionsPerPack || 1,
                        sessionsUsed: 0,
                        status: "active",
                        expiresAt: pkg.sessionsPerPack
                            ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
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

        // Create UserPackage with credits
        const userPackage = await prisma.userPackage.create({
            data: {
                userId: order.userId,
                packageId: order.packageId,
                orderId: order.id,
                title: pkg.title,
                minutesPerSession: pkg.durationMin || null,
                sessionsTotal: pkg.sessionsPerPack || 1,
                sessionsUsed: 0,
                status: "active",
                expiresAt: pkg.sessionsPerPack
                    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year expiry
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
