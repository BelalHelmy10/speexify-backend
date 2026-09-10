// src/routes/onboarding-assessment.js
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { formatZodError } from "../middleware/validateRequest.js";
import { logger } from "../lib/logger.js";
import {
  buildAssessmentReviewUpdateData,
  parseAssessmentReviewBody,
} from "../services/assessmentReviewService.js";
import { validatePlacementEvidence } from "../services/placementEvidence.js";
import { scoreObjectiveAssessment } from "../services/placementScoring.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* Validation / constants for onboarding & assessment                         */
/* -------------------------------------------------------------------------- */

const ASSESS_MAX_HARD = 600;

const SkillsEnum = z.enum([
  "Speaking",
  "Listening",
  "Reading",
  "Writing",
  "Pronunciation",
  "Grammar",
  "Vocabulary",
]);

const PreferredFormatEnum = z.enum(["1:1", "group", "intensive"]);
const UsageFrequencyEnum = z.enum(["never", "sometimes", "often", "daily"]);
const UsageContextEnum = z.enum([
  "work_emails",
  "meetings_presentations",
  "client_communication",
  "academic_writing",
  "research_reading",
  "social_conversation",
  "travel_situations",
  "other",
]);
const MotivationEnum = z.enum([
  "professional_development",
  "academic_studies",
  "exam_preparation",
  "immigration_relocation",
  "travel",
  "social_personal_growth",
  "other",
]);
const LearningStyleEnum = z.enum([
  "structured_grammar",
  "interactive_speaking",
  "task_project",
  "listening_video",
  "reading_vocab",
  "self_paced",
]);
const OnboardingStatusEnum = z.enum(["draft", "submitted"]);

const OnboardingAnswersSchema = z.object({
  // Profile / logistics
  timezone: z.string().trim().min(1).max(80),
  availability: z.string().max(2000).optional().default(""),
  preferredFormat: PreferredFormatEnum.optional().default("1:1"),
  notes: z.string().optional().default(""),

  // Goals & context
  goals: z.string().optional().default(""),
  context: z.string().optional().default(""),
  levelSelfEval: z.string().optional().default(""),
  usageFrequency: UsageFrequencyEnum.or(z.literal("")).optional().default(""),
  usageContexts: z.array(UsageContextEnum).max(8).optional().default([]),

  // Needs analysis
  motivations: z.array(MotivationEnum).max(7).optional().default([]),
  motivationOther: z.string().optional().default(""),
  examDetails: z.string().optional().default(""),
  skillPriority: z.record(SkillsEnum, z.number().min(1).max(5)).optional(),
  challenges: z.string().optional().default(""),
  learningStyles: z.array(LearningStyleEnum).max(6).optional().default([]),

  // Self-assessment
  confidence: z
    .record(
      z.enum(["Speaking", "Listening", "Reading", "Writing"]),
      z.number().min(1).max(10)
    )
    .optional(),
  consentRecording: z.boolean().optional().default(false),
});

const AdminIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const AdminIntakeQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  userId: z.coerce.number().int().positive().optional(),
  status: z
    .enum([
      "all",
      "onboarding_submitted",
      "assessment_submitted",
      "needs_review",
      "reviewed",
      "missing_onboarding",
      "missing_assessment",
    ])
    .optional()
    .default("all"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const AdminListQuerySchema = z.object({
  userId: z.union([z.coerce.number().int().positive(), z.literal("")]).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  timezone: true,
  isDisabled: true,
  createdAt: true,
};

const ONBOARDING_LIST_SELECT = {
  id: true,
  userId: true,
  packageId: true,
  status: true,
  answers: true,
  createdAt: true,
  updatedAt: true,
};

const ASSESSMENT_LIST_SELECT = {
  id: true,
  userId: true,
  packageId: true,
  status: true,
  score: true,
  cefr: true,
  feedback: true,
  reviewedAt: true,
  reviewedById: true,
  wordCount: true,
  createdAt: true,
  updatedAt: true,
};

const ASSESSMENT_RESPONSE_SELECT = { ...ASSESSMENT_LIST_SELECT, reviewMeta: true };

const ASSESSMENT_DETAIL_SELECT = {
  ...ASSESSMENT_RESPONSE_SELECT,
  text: true,
  user: { select: USER_PUBLIC_SELECT },
  reviewedBy: {
    select: {
      id: true,
      email: true,
      name: true,
    },
  },
};

function buildLearnerSearchWhere({ q = "", userId } = {}) {
  const where = { role: "learner" };

  if (userId) {
    where.id = Number(userId);
  }

  if (q) {
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
    ];
  }

  return where;
}

function buildIntakeWhere({ q, userId, status }) {
  const where = buildLearnerSearchWhere({ q, userId });

  if (status === "onboarding_submitted") {
    where.onboardingForms = { some: { status: "submitted" } };
  } else if (status === "assessment_submitted") {
    where.assessmentSubmissions = { some: {} };
  } else if (status === "needs_review") {
    where.assessmentSubmissions = {
      some: { status: { in: ["submitted", "auto_scored", "awaiting_review"] } },
    };
  } else if (status === "reviewed") {
    where.assessmentSubmissions = { some: { status: "reviewed" } };
  } else if (status === "missing_onboarding") {
    where.onboardingForms = { none: { status: "submitted" } };
  } else if (status === "missing_assessment") {
    where.assessmentSubmissions = { none: {} };
  }

  return where;
}

function latestOrNull(rows) {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/* ========================================================================== */
/*                        ADMIN: ONBOARDING + ASSESSMENTS                     */
/* ========================================================================== */

// GET /api/admin/intake?q=&userId=&status=&limit=&offset=
router.get("/admin/intake", requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = AdminIntakeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "query"),
      });
    }

    const { q, userId, status, limit, offset } = parsed.data;
    const where = buildIntakeWhere({ q, userId, status });
    const summaryUserWhere = buildLearnerSearchWhere({ q, userId });
    const linkedUserWhere = { user: summaryUserWhere };

    const [
      users,
      total,
      learnersTotal,
      onboardingFormsTotal,
      assessmentsTotal,
      needsReviewTotal,
      reviewedAssessmentsTotal,
    ] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          ...USER_PUBLIC_SELECT,
          onboardingForms: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: ONBOARDING_LIST_SELECT,
          },
          assessmentSubmissions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: ASSESSMENT_LIST_SELECT,
          },
          _count: {
            select: {
              onboardingForms: true,
              assessmentSubmissions: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
      prisma.user.count({ where: summaryUserWhere }),
      prisma.onboardingForm.count({
        where: { ...linkedUserWhere, status: "submitted" },
      }),
      prisma.assessmentSubmission.count({ where: linkedUserWhere }),
      prisma.assessmentSubmission.count({
        where: {
          ...linkedUserWhere,
          status: { in: ["submitted", "auto_scored", "awaiting_review"] },
        },
      }),
      prisma.assessmentSubmission.count({
        where: {
          ...linkedUserWhere,
          status: "reviewed",
        },
      }),
    ]);

    const items = users.map((user) => ({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        timezone: user.timezone,
        isDisabled: user.isDisabled,
        createdAt: user.createdAt,
      },
      latestOnboarding: latestOrNull(user.onboardingForms),
      latestAssessment: latestOrNull(user.assessmentSubmissions),
      counts: user._count,
    }));

    res.json({
      items,
      total,
      limit,
      offset,
      summary: {
        learnersTotal,
        onboardingFormsTotal,
        assessmentsTotal,
        needsReviewTotal,
        reviewedAssessmentsTotal,
      },
    });
  } catch (e) {
    logger.error({ err: e }, "admin.intake.list error");
    res.status(500).json({ error: "Failed to load learner intake" });
  }
});

// GET /api/admin/users/:id/intake
router.get(
  "/admin/users/:id/intake",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const parsed = AdminIdParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: formatZodError(parsed.error, "params"),
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: parsed.data.id },
        select: {
          ...USER_PUBLIC_SELECT,
          onboardingForms: {
            orderBy: { createdAt: "desc" },
            select: ONBOARDING_LIST_SELECT,
          },
          assessmentSubmissions: {
            orderBy: { createdAt: "desc" },
            select: ASSESSMENT_DETAIL_SELECT,
          },
        },
      });

      if (!user || user.role !== "learner") {
        return res.status(404).json({ error: "Learner not found" });
      }

      const { onboardingForms, assessmentSubmissions, ...learner } = user;
      res.json({
        user: learner,
        onboardingForms,
        assessments: assessmentSubmissions,
        latestOnboarding: latestOrNull(onboardingForms),
        latestAssessment: latestOrNull(assessmentSubmissions),
      });
    } catch (e) {
      logger.error({ err: e }, "admin.intake.detail error");
      res.status(500).json({ error: "Failed to load learner intake detail" });
    }
  }
);

// GET /api/admin/onboarding?userId=&limit=&offset=
router.get("/admin/onboarding", requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = AdminListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "query"),
      });
    }

    const { userId, limit, offset } = parsed.data;
    const where = userId ? { userId: Number(userId) } : {};
    const [items, total] = await Promise.all([
      prisma.onboardingForm.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          ...ONBOARDING_LIST_SELECT,
          user: { select: USER_PUBLIC_SELECT },
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
      const parsed = AdminListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: formatZodError(parsed.error, "query"),
        });
      }

      const { userId, limit, offset } = parsed.data;
      const where = userId ? { userId: Number(userId) } : {};
      const [items, total] = await Promise.all([
        prisma.assessmentSubmission.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          select: {
            ...ASSESSMENT_LIST_SELECT,
            user: { select: USER_PUBLIC_SELECT },
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

// GET /api/admin/assessments/:id
router.get(
  "/admin/assessments/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const parsed = AdminIdParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: formatZodError(parsed.error, "params"),
        });
      }

      const assessment = await prisma.assessmentSubmission.findUnique({
        where: { id: parsed.data.id },
        select: ASSESSMENT_DETAIL_SELECT,
      });

      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      res.json({ assessment });
    } catch (e) {
      logger.error({ err: e }, "admin.assessments.detail error");
      res.status(500).json({ error: "Failed to load assessment" });
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
    const {
      answers = {},
      packageId = null,
      status: requestedStatus = "submitted",
    } = req.body || {};
    const statusResult = OnboardingStatusEnum.safeParse(requestedStatus);
    if (!statusResult.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: [{ path: "status", message: "Status must be draft or submitted" }],
      });
    }
    const normalizedPackageId =
      packageId === null || packageId === "" || typeof packageId === "undefined"
        ? null
        : Number(packageId);
    if (
      normalizedPackageId !== null &&
      (!Number.isInteger(normalizedPackageId) || normalizedPackageId <= 0)
    ) {
      return res.status(400).json({ error: "Invalid package id" });
    }

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

    // 3) Keep one current form per learner. Draft saves and final submission
    // update the same record, so retries never create duplicate intake rows.
    const current = await prisma.onboardingForm.findFirst({
      where: { userId: req.viewUserId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const data = {
      packageId: normalizedPackageId,
      answers: clean,
      status: statusResult.data,
    };
    const created = current
      ? await prisma.onboardingForm.update({ where: { id: current.id }, data })
      : await prisma.onboardingForm.create({
          data: { userId: req.viewUserId, ...data },
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
      select: { ...ASSESSMENT_RESPONSE_SELECT, text: true },
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
      attemptId: requestedAttemptId = null,
      reviewMeta = null,
    } = req.body || {};
    const attemptId =
      typeof requestedAttemptId === "string" && requestedAttemptId.trim().length >= 12
        ? requestedAttemptId.trim().slice(0, 120)
        : randomUUID();
    const input = String(text || "");
    const normalized = input.replace(/\r\n/g, "\n").trim();
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const cleanReviewMeta =
      reviewMeta && typeof reviewMeta === "object" && !Array.isArray(reviewMeta)
        ? reviewMeta
        : null;
    if (!cleanReviewMeta?.answers || typeof cleanReviewMeta.answers !== "object") {
      return res.status(400).json({ error: "Objective answer payload is required" });
    }
    const evidence = validatePlacementEvidence(cleanReviewMeta);
    if (!evidence.ok) return res.status(evidence.status).json({ error: evidence.error });
    let reviewMetaSize = 0;
    try {
      reviewMetaSize = JSON.stringify(cleanReviewMeta).length;
    } catch {
      return res.status(400).json({ error: "Invalid assessment metadata" });
    }
    if (reviewMetaSize > 3_500_000) {
      return res.status(413).json({ error: "Assessment metadata is too large" });
    }

    const normalizedPackageId =
      packageId === null || packageId === "" || typeof packageId === "undefined"
        ? null
        : Number(packageId);
    if (
      normalizedPackageId !== null &&
      (!Number.isInteger(normalizedPackageId) || normalizedPackageId <= 0)
    ) {
      return res.status(400).json({ error: "Invalid package id" });
    }

    if (wordCount === 0) {
      return res.status(400).json({ error: "Submission is empty" });
    }
    if (wordCount > ASSESS_MAX_HARD) {
      return res
        .status(413)
        .json({ error: `Submission too long (>${ASSESS_MAX_HARD} words)` });
    }

    const answers = cleanReviewMeta?.answers;
    const objective = scoreObjectiveAssessment(answers);
    if (!objective.complete) {
      return res.status(400).json({
        error: "Please complete all objective placement questions before submitting",
        answered: objective.answered,
        total: objective.total,
      });
    }

    const safeMeta = {
      placementVersion: String(cleanReviewMeta.placementVersion || "speexify-placement-v2"),
      answers: cleanReviewMeta.answers,
      speaking: evidence.speaking,
      writingTaskId: evidence.writingTaskId,
      listeningPlays: cleanReviewMeta.listeningPlays || {},
      completedAt: new Date().toISOString(),
      attemptId,
      placementResult: {
        version: objective.version,
        score: objective.score,
        band: objective.band,
        sectionScores: objective.sectionScores,
        status: "awaiting_review",
      },
      scoring: {
        source: "server",
        version: objective.version,
        objective,
      },
    };

    // Serialize submissions per learner so simultaneous retries cannot create duplicates.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(91831, ${req.viewUserId}::integer)`;
      const existing = await tx.assessmentSubmission.findFirst({
        where: { userId: req.viewUserId, reviewMeta: { path: ["attemptId"], equals: attemptId } },
        select: ASSESSMENT_RESPONSE_SELECT,
      });
      if (existing) return { submission: existing, idempotent: true };
      const created = await tx.assessmentSubmission.create({
        data: {
          userId: req.viewUserId,
          packageId: normalizedPackageId,
          text: normalized,
          wordCount,
          status: "awaiting_review",
          score: objective.score,
          cefr: null,
          feedback: evidence.speaking.mode === "live"
            ? "Your answers have been received. A coach will review your writing and complete a live speaking check before confirming your level."
            : "Your answers and recording have been received. A coach will review your speaking and writing before confirming your level.",
          reviewMeta: safeMeta,
        },
        select: ASSESSMENT_RESPONSE_SELECT,
      });
      return { submission: created, idempotent: false };
    });
    res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result });
  } catch (e) {
    logger.error({ err: e }, "POST /api/me/assessment failed");
    res.status(500).json({ error: "Failed to submit assessment" });
  }
});

export default router;
