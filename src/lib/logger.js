// src/lib/logger.js
import pino from "pino";
import { LOG_LEVEL } from "../config/env.js";
import { getRequestContext } from "../observability/requestContext.js";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: LOG_LEVEL,
  base: {
    service: "speexify-backend",
    env: process.env.NODE_ENV || "development",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  mixin() {
    const context = getRequestContext();
    if (!context) return {};
    return {
      requestId: context.requestId,
      traceId: context.traceId,
      spanId: context.spanId,
    };
  },
  transport: isProd
    ? undefined
    : {
        // Pretty logs in dev
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname,service,env",
        },
      },
});
