// src/config/sentry.js
import * as Sentry from "@sentry/node";
import {
  isProd,
  SENTRY_TRACES_SAMPLE_RATE,
  SENTRY_PROFILES_SAMPLE_RATE,
} from "./env.js";

const SENTRY_DSN_BACKEND = process.env.SENTRY_DSN_BACKEND || "";

export function initSentry(app) {
  if (!SENTRY_DSN_BACKEND) {
    return; // Sentry not configured; do nothing
  }

  Sentry.init({
    dsn: SENTRY_DSN_BACKEND,
    environment: isProd ? "production" : "development",
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: SENTRY_PROFILES_SAMPLE_RATE,
    sendDefaultPii: false,
  });

  // Request handler must be the first middleware
  app.use(Sentry.Handlers.requestHandler());
}
