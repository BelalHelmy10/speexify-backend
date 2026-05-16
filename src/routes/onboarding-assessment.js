// src/routes/onboarding-assessment.js
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { formatZodError } from "../middleware/validateRequest.js";
import { logger } from "../lib/logger.js";
import {
  buildAssessmentReviewUpdateData,
  parseAssessmentReviewBody,
} from "../services/assessmentReviewService.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* Validation / constants for onboarding & assessment                         */
/* -------------------------------------------------------------------------- */

const ASSESS_MIN_HARD = 120; // match frontend HARD_MIN
const ASSESS_MIN_SOFT = 150; // match frontend TARGET_MIN
const ASSESS_MAX_SOFT = 250; // match frontend TARGET_MAX
const ASSESS_MAX_HARD = 600; // match frontend HARD_MAX

const SkillsEnum = z.enum([
  "Speaking",
  "Listening",
  "Reading",
  "Writing",
  "Pronunciation",
  "Grammar",
  "Vocabulary",
]);

const OnboardingAnswersSchema = z.object({
  // Profile / logistics
  timezone: z.string().min(1),
  availability: z.string().optional().default(""),
  preferredFormat: z.string().optional().default("1:1"),
  notes: z.string().optional().default(""),

  // Goals & context
  goals: z.string().optional().default(""),
  context: z.string().optional().default(""),
  levelSelfEval: z.string().optional().default(""),
  usageFrequency: z.string().optional().default(""),
  usageContexts: z.array(z.string()).optional().default([]),

  // Needs analysis
  motivations: z.array(z.string()).optional().default([]),
  motivationOther: z.string().optional().default(""),
  examDetails: z.string().optional().default(""),
  skillPriority: z.record(SkillsEnum, z.number().min(1).max(5)).optional(),
  challenges: z.string().optional().default(""),
  learningStyles: z.array(z.string()).optional().default([]),

  // Self-assessment
  confidence: z
    .record(
      z.enum(["Speaking", "Listening", "Reading", "Writing"]),
      z.number().min(1).max(10)
    )
    .optional(),
  writingSample: z.string().optional().default(""),
  consentRecording: z.boolean().optional().default(false),
});

/* ========================================================================== */
/*                        ADMIN: ONBOARDING + ASSESSMENTS                     */
/* ========================================================================== */

// GET /api/admin/onboarding?userId=&limit=&offset=
router.get("/admin/onboarding", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId = "", limit = "50", offset = "0" } = req.query;
    const where = userId ? { userId: Number(userId) } : {};
    const [items, total] = await Promise.all([
      prisma.onboardingForm.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Number(limit),
        skip: Number(offset),
        select: {
          id: true,
          userId: true,
          packageId: true,
          status: true,
          createdAt: true,
          answers: true,
        },
      }),
      prisma.onboardingForm.count({ where }),
    ]);
    res.json({ items, total });
  } catch (e) {
    logger.error({ err: e }, "admin.onboarding.list error");
    res.status(500).json({ error: "Failed to load onboarding forms" });
  }
});

// GET /api/admin/assessments?userId=&limit=&offset=
router.get(
  "/admin/assessments",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { userId = "", limit = "50", offset = "0" } = req.query;
      const where = userId ? { userId: Number(userId) } : {};
      const [items, total] = await Promise.all([
        prisma.assessmentSubmission.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: Number(limit),
          skip: Number(offset),
          select: {
            id: true,
            userId: true,
            packageId: true,
            status: true,
            score: true,
            cefr: true,
            feedback: true,
            reviewMeta: true,
            reviewedAt: true,
            reviewedById: true,
            wordCount: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.assessmentSubmission.count({ where }),
      ]);
      res.json({ items, total });
    } catch (e) {
      logger.error({ err: e }, "admin.assessments.list error");
      res.status(500).json({ error: "Failed to load assessments" });
    }
  }
);

// POST /api/admin/assessments/:id/review
router.post(
  "/admin/assessments/:id/review",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid assessment id" });
      }

      const parsed = parseAssessmentReviewBody(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: formatZodError(parsed.error, "body"),
        });
      }

      const updated = await prisma.assessmentSubmission.update({
        where: { id },
        data: buildAssessmentReviewUpdateData({
          review: parsed.data,
          reviewerId: req.user.id,
        }),
        select: {
          id: true,
          userId: true,
          packageId: true,
          status: true,
          score: true,
          cefr: true,
          feedback: true,
          reviewMeta: true,
          reviewedAt: true,
          reviewedById: true,
          wordCount: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      res.json({ ok: true, assessment: updated });
    } catch (e) {
      if (e?.code === "P2025") {
        return res.status(404).json({ error: "Assessment not found" });
      }

      logger.error({ err: e }, "admin.assessments.review error");
      res.status(500).json({ error: "Failed to review assessment" });
    }
  }
);

/* ========================================================================== */
/*                             ME: ONBOARDING                                  */
/* ========================================================================== */

// GET /api/me/onboarding
router.get("/me/onboarding", requireAuth, async (req, res) => {
  try {
    const row = await prisma.onboardingForm.findFirst({
      where: { userId: req.viewUserId },
      orderBy: { createdAt: "desc" },
    });
    res.json(row || null);
  } catch (e) {
    logger.error({ err: e }, "GET /api/me/onboarding failed");
    res.status(500).json({ error: "Failed to load onboarding form" });
  }
});

// POST /api/me/onboarding
router.post("/me/onboarding", requireAuth, async (req, res) => {
  try {
    const { answers = {}, packageId = null } = req.body || {};

    // 1) Validate
    const parsed = OnboardingAnswersSchema.safeParse(answers);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
    }

    // 2) Clamp long text fields
    const clamp = (s, n = 5000) => (typeof s === "string" ? s.slice(0, n) : s);
    const clean = parsed.data;
    clean.availability = clamp(clean.availability);
    clean.notes = clamp(clean.notes);
    clean.goals = clamp(clean.goals);
    clean.context = clamp(clean.context);
    clean.motivationOther = clamp(clean.motivationOther);
    clean.examDetails = clamp(clean.examDetails);
    clean.challenges = clamp(clean.challenges);
    clean.writingSample = clamp(clean.writingSample, 8000);

    // 3) Create submission
    const created = await prisma.onboardingForm.create({
      data: {
        userId: req.viewUserId,
        packageId: packageId ? Number(packageId) : null,
        answers: clean,
        status: "submitted",
      },
    });

    // 4) Copy timezone onto User if provided
    if (clean.timezone) {
      await prisma.user.update({
        where: { id: req.viewUserId },
        data: { timezone: clean.timezone },
      });
      if (req.viewUserId === req.user.id && req.session?.user) {
        req.session.user.timezone = clean.timezone;
      }
    }

    return res.status(201).json({ ok: true, form: created });
  } catch (e) {
    logger.error({ err: e }, "POST /api/me/onboarding failed");
    res.status(500).json({ error: "Failed to save onboarding form" });
  }
});

/* ========================================================================== */
/*                           ME: ASSESSMENT (WRITING)                         */
/* ========================================================================== */

// GET /api/me/assessment
router.get("/me/assessment", requireAuth, async (req, res) => {
  try {
    const row = await prisma.assessmentSubmission.findFirst({
      where: { userId: req.viewUserId },
      orderBy: { createdAt: "desc" },
    });
    res.json(row || null);
  } catch (e) {
    logger.error({ err: e }, "GET /api/me/assessment failed");
    res.status(500).json({ error: "Failed to load assessment" });
  }
});

// POST /api/me/assessment
router.post("/me/assessment", requireAuth, async (req, res) => {
  try {
    const {
      text = "",
      packageId = null,
      score = null,
      cefr = null,
      feedback = null,
      reviewMeta = null,
    } = req.body || {};
    const input = String(text || "");
    const normalized = input.replace(/\r\n/g, "\n").trim();
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const normalizedScore = Number(score);
    const cleanScore = Number.isFinite(normalizedScore)
      ? Math.max(0, Math.min(100, Math.round(normalizedScore)))
      : null;
    const cleanCefr =
      typeof cefr === "string" &&
      /^(A1|A2|B1|B2|C1|C2)(\.[12])?$/i.test(cefr.trim())
        ? cefr.trim().toUpperCase()
        : null;
    const cleanFeedback =
      typeof feedback === "string" ? feedback.trim().slice(0, 5000) : null;
    const cleanReviewMeta =
      reviewMeta && typeof reviewMeta === "object" && !Array.isArray(reviewMeta)
        ? reviewMeta
        : null;

    if (wordCount === 0) {
      return res.status(400).json({ error: "Submission is empty" });
    }
    if (wordCount > ASSESS_MAX_HARD) {
      return res
        .status(413)
        .json({ error: `Submission too long (>${ASSESS_MAX_HARD} words)` });
    }

    const created = await prisma.assessmentSubmission.create({
      data: {
        userId: req.viewUserId,
        packageId: packageId ? Number(packageId) : null,
        text: normalized,
        wordCount: Number(wordCount),
        status: cleanCefr ? "auto_scored" : "submitted",
        score: cleanScore,
        cefr: cleanCefr,
        feedback: cleanFeedback,
        reviewMeta: cleanReviewMeta,
      },
    });
    res.status(201).json({ ok: true, submission: created });
  } catch (e) {
    logger.error({ err: e }, "POST /api/me/assessment failed");
    res.status(500).json({ error: "Failed to submit assessment" });
  }
});

export default router;
