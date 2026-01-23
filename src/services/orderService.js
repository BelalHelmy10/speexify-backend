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
        // Update order status
        const order = await prisma.order.update({
            where: { id: orderId },
            data: {
                status: "paid",
                paymobTxnId: paymobTxnId ? Number(paymobTxnId) : null,
                updatedAt: new Date(),
            },
            include: {
                userPackage: true,
            },
        });

        logger.info({ orderId, paymobTxnId }, "Order marked as paid");

        // If UserPackage already exists for this order, don't create duplicate
        if (order.userPackage) {
            logger.warn({ orderId }, "UserPackage already exists for this order, skipping credit grant");
            return { order, alreadyGranted: true };
        }

        // Grant credits by creating UserPackage
        const userPackage = await grantPackageCredits(order);

        return { order, userPackage, alreadyGranted: false };
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
        const order = await prisma.order.update({
            where: { id: orderId },
            data: {
                status: "failed",
                updatedAt: new Date(),
            },
        });

        logger.info({ orderId, reason }, "Order marked as failed");

        return order;
    } catch (error) {
        logger.error({ error, orderId, reason }, "Failed to mark order as failed");
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
