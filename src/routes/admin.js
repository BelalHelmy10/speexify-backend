import { Router } from "express";
import usersRoutes from "./admin/usersRoutes.js";
import impersonationRoutes from "./admin/impersonationRoutes.js";
import teacherWorkloadRoutes from "./admin/teacherWorkloadRoutes.js";
import userPackagesRoutes from "./admin/userPackagesRoutes.js";
import userAttendanceRoutes from "./admin/userAttendanceRoutes.js";
import paymentsRoutes from "./admin/paymentsRoutes.js";
import registrationsRoutes from "./admin/registrationsRoutes.js";

const router = Router();

router.use(usersRoutes);
router.use(impersonationRoutes);
router.use(teacherWorkloadRoutes);
router.use(userPackagesRoutes);
router.use(userAttendanceRoutes);
router.use(paymentsRoutes);
router.use(registrationsRoutes);

export default router;
