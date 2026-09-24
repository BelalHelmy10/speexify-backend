import { UPLOADS_ENABLED } from "../config/env.js";

export const UPLOADS_DISABLED_MESSAGE =
  "File uploads are temporarily unavailable while secure external storage is being configured.";

export function uploadsDisabledError() {
  const error = new Error(UPLOADS_DISABLED_MESSAGE);
  error.statusCode = 503;
  error.code = "UPLOADS_DISABLED";
  return error;
}

export function requireUploadsEnabled(_req, res, next) {
  if (!UPLOADS_ENABLED) {
    return res.status(503).json({
      error: UPLOADS_DISABLED_MESSAGE,
      code: "UPLOADS_DISABLED",
    });
  }
  return next();
}
