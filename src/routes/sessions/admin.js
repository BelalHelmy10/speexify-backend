// src/routes/sessions/admin.js
// Admin session route composer (split into bounded modules)

import { Router } from "./_shared.js";
import listRoutes from "./admin/listRoutes.js";
import previewRoutes from "./admin/previewRoutes.js";
import createRoutes from "./admin/createRoutes.js";
import participantRoutes from "./admin/participantRoutes.js";
import updateRoutes from "./admin/updateRoutes.js";
import deleteRoutes from "./admin/deleteRoutes.js";
import bulkRoutes from "./admin/bulkRoutes.js";

const router = Router();

router.use(listRoutes);
router.use(previewRoutes);
router.use(createRoutes);
router.use(participantRoutes);
router.use(updateRoutes);
router.use(deleteRoutes);
router.use(bulkRoutes);

export default router;
