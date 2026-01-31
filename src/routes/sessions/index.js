// src/routes/sessions/index.js
// Router aggregator - combines all session route modules into a single export

import { Router } from "./_shared.js";

// Import all sub-routers
import conflictsRouter from "./conflicts.js";
import crudRouter from "./crud.js";
import teacherRouter from "./teacher.js";
import feedbackRouter from "./feedback.js";
import attendanceRouter from "./attendance.js";
import lifecycleRouter from "./lifecycle.js";
import learnerRouter from "./learner.js";
import adminRouter from "./admin.js";
import classroomRouter from "./classroom.js";

const router = Router();

// Mount all sub-routers
// Order matters for route matching - more specific routes should come first
router.use(conflictsRouter);
router.use(teacherRouter);
router.use(feedbackRouter);
router.use(attendanceRouter);
router.use(lifecycleRouter);
router.use(learnerRouter);
router.use(adminRouter);
router.use(classroomRouter);
router.use(crudRouter); // CRUD routes last since they have catch-all patterns like /sessions/:id

export default router;
