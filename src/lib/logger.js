// src/lib/logger.js
import pino from "pino";
import { LOG_LEVEL } from "../config/env.js";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: LOG_LEVEL,
  transport: isProd
    ? undefined
    : {
        // Pretty logs in dev
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
});
