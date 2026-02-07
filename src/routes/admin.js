import { Router } from "express";
import usersRoutes from "./admin/usersRoutes.js";
import impersonationRoutes from "./admin/impersonationRoutes.js";
import teacherWorkloadRoutes from "./admin/teacherWorkloadRoutes.js";
import userPackagesRoutes from "./admin/userPackagesRoutes.js";
import userAttendanceRoutes from "./admin/userAttendanceRoutes.js";

const router = Router();

router.use(usersRoutes);
router.use(impersonationRoutes);
router.use(teacherWorkloadRoutes);
router.use(userPackagesRoutes);
router.use(userAttendanceRoutes);

export default router;
