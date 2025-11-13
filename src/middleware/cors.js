// src/middleware/cors.js
import cors from "cors";
import { ALLOWED_ORIGINS } from "../config/env.js";

const corsOptions = {
  origin(origin, cb) {
    // Allow requests with no origin (like curl, Postman, mobile apps)
    if (!origin) return cb(null, true);

    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }

    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 204,
};

export const corsMiddleware = cors(corsOptions);
