import { Router } from "express";
import { requireAuth } from "../middleware/auth-helpers.js";
import { sendEmail } from "../services/emailService.js";

const router = Router();

router.get("/dev/test-email", requireAuth, async (req, res) => {
  await sendEmail(
    req.user.email,
    "Speexify — Resend test ✅",
    "<h2>Email is working 🎉</h2><p>This was sent via Resend.</p>"
  );

  return res.json({ ok: true, to: req.user.email });
});

export default router;
