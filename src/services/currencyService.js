// src/services/currencyService.js
import { logger } from "../lib/logger.js";

// In-memory cache for exchange rates (1 hour TTL)
const rateCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch exchange rate from API with caching
 * @param {string} fromCurrency - Source currency (e.g., "USD")
 * @param {string} toCurrency - Target currency (e.g., "EGP")
 * @returns {Promise<number>} Exchange rate
 */
export async function getExchangeRate(fromCurrency, toCurrency) {
    // Same currency = no conversion
    if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
        return 1;
    }

    const cacheKey = `${fromCurrency}:${toCurrency}`;

    // Check cache
    const cached = rateCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        logger.debug({ cacheKey, rate: cached.rate }, "Using cached exchange rate");
        return cached.rate;
    }

    try {
        // Use exchangerate-api.com (free tier: 1500 requests/month)
        const response = await fetch(
            `https://api.exchangerate-api.com/v4/latest/${fromCurrency}`
        );

        if (!response.ok) {
            throw new Error(`Exchange rate API error: ${response.status}`);
        }

        const data = await response.json();
        const rate = data?.rates?.[toCurrency];

        if (!rate) {
            throw new Error(`Rate not found for ${fromCurrency} -> ${toCurrency}`);
        }

        // Cache the rate
        rateCache.set(cacheKey, { rate, timestamp: Date.now() });

        logger.info(
            { fromCurrency, toCurrency, rate },
            "Fetched fresh exchange rate"
        );

        return rate;
    } catch (error) {
        logger.error(
            { error, fromCurrency, toCurrency },
            "Failed to fetch exchange rate"
        );

        // If we have a stale cached rate, use it as fallback
        if (cached) {
            logger.warn(
                { cacheKey, rate: cached.rate },
                "Using stale cached rate as fallback"
            );
            return cached.rate;
        }

        // Last resort: throw error (don't silently return 1 for payment amounts)
        throw new Error(
            `Unable to get exchange rate for ${fromCurrency} -> ${toCurrency}`
        );
    }
}

/**
 * Convert an amount from display currency to EGP for Paymob payment
 * @param {number} amount - Amount in display currency
 * @param {string} fromCurrency - Display currency (e.g., "USD")
 * @returns {Promise<{egpAmount: number, rate: number}>}
 */
export async function convertToEGP(amount, fromCurrency) {
    if (fromCurrency === "EGP") {
        return { egpAmount: Math.round(amount), rate: 1 };
    }

    const rate = await getExchangeRate(fromCurrency, "EGP");
    const egpAmount = Math.round(amount * rate);

    logger.info(
        { amount, fromCurrency, rate, egpAmount },
        "Converted amount to EGP"
    );

    return { egpAmount, rate };
}

/**
 * Convert EGP to display currency (for showing user what they paid)
 * @param {number} egpAmount - Amount in EGP
 * @param {string} toCurrency - Target currency
 * @returns {Promise<{displayAmount: number, rate: number}>}
 */
export async function convertFromEGP(egpAmount, toCurrency) {
    if (toCurrency === "EGP") {
        return { displayAmount: egpAmount, rate: 1 };
    }

    const rate = await getExchangeRate("EGP", toCurrency);
    const displayAmount = Math.round(egpAmount * rate * 100) / 100; // 2 decimal places

    return { displayAmount, rate };
}

/**
 * Clear the rate cache (useful for testing)
 */
export function clearRateCache() {
    rateCache.clear();
}
