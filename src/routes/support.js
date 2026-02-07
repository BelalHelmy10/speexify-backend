// src/routes/support.js
import { Router } from "express";
import userRoutes from "./support/userRoutes.js";
import adminRoutes from "./support/adminRoutes.js";

const router = Router();

// User and admin support routes are split into bounded modules to keep
// this entrypoint stable and easy to reason about.
router.use(userRoutes);
router.use(adminRoutes);

export default router;
