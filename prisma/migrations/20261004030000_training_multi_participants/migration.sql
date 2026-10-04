-- Preserve membership for training sessions created before multi-person booking.
INSERT INTO "SessionParticipant" ("sessionId", "userId", "status", "createdAt", "updatedAt")
SELECT s."id", s."teacherId", 'booked', NOW(), NOW()
FROM "Session" AS s
WHERE s."type" = 'TRAINING' AND s."teacherId" IS NOT NULL
ON CONFLICT ("sessionId", "userId") DO NOTHING;
