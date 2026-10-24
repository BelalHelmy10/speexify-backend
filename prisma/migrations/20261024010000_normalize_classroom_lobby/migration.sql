-- Keep the live teaching document independently versioned so partial updates can
-- be merged with compare-and-swap semantics instead of overwriting a stale read.
ALTER TABLE "Session"
ADD COLUMN "classroomStateVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "ClassroomLobbyStatus" AS ENUM ('WAITING', 'ADMITTED', 'DENIED');

CREATE TABLE "ClassroomLobbyEntry" (
    "sessionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "ClassroomLobbyStatus" NOT NULL DEFAULT 'WAITING',
    "displayName" TEXT,
    "email" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomLobbyEntry_pkey" PRIMARY KEY ("sessionId", "userId")
);

CREATE INDEX "ClassroomLobbyEntry_sessionId_status_joinedAt_idx"
ON "ClassroomLobbyEntry"("sessionId", "status", "joinedAt");

CREATE INDEX "ClassroomLobbyEntry_userId_idx"
ON "ClassroomLobbyEntry"("userId");

ALTER TABLE "ClassroomLobbyEntry"
ADD CONSTRAINT "ClassroomLobbyEntry_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassroomLobbyEntry"
ADD CONSTRAINT "ClassroomLobbyEntry_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill legacy waiting entries. WITH ORDINALITY preserves their relative
-- queue order without trusting arbitrary timestamp strings stored in JSON.
INSERT INTO "ClassroomLobbyEntry" (
    "sessionId",
    "userId",
    "status",
    "displayName",
    "email",
    "joinedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    session_row."id",
    waiting_entry."userId",
    'WAITING'::"ClassroomLobbyStatus",
    NULLIF(waiting_entry."entry"->>'name', ''),
    NULLIF(waiting_entry."entry"->>'email', ''),
    CURRENT_TIMESTAMP + waiting_entry."position" * INTERVAL '1 millisecond',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Session" AS session_row
CROSS JOIN LATERAL (
    SELECT
        CASE
            WHEN item."value"->>'id' ~ '^[1-9][0-9]*$'
                AND length(item."value"->>'id') <= 10
            THEN CASE
                WHEN (item."value"->>'id')::NUMERIC <= 2147483647
                THEN (item."value"->>'id')::INTEGER
            END
        END AS "userId",
        item."value" AS "entry",
        item."ordinality" AS "position"
    FROM jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(session_row."classroomState"->'lobby'->'waiting') = 'array'
            THEN session_row."classroomState"->'lobby'->'waiting'
            ELSE '[]'::JSONB
        END
    ) WITH ORDINALITY AS item("value", "ordinality")
) AS waiting_entry
JOIN "User" AS learner ON learner."id" = waiting_entry."userId"
ON CONFLICT ("sessionId", "userId") DO NOTHING;

-- A legacy denial takes precedence over a waiting row.
INSERT INTO "ClassroomLobbyEntry" (
    "sessionId", "userId", "status", "decidedAt", "createdAt", "updatedAt"
)
SELECT
    session_row."id",
    denied_entry."userId",
    'DENIED'::"ClassroomLobbyStatus",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Session" AS session_row
CROSS JOIN LATERAL (
    SELECT CASE
        WHEN item."value" ~ '^[1-9][0-9]*$'
            AND length(item."value") <= 10
        THEN CASE
            WHEN item."value"::NUMERIC <= 2147483647
            THEN item."value"::INTEGER
        END
    END AS "userId"
    FROM jsonb_array_elements_text(
        CASE
            WHEN jsonb_typeof(session_row."classroomState"->'lobby'->'denied') = 'array'
            THEN session_row."classroomState"->'lobby'->'denied'
            ELSE '[]'::JSONB
        END
    ) AS item("value")
) AS denied_entry
JOIN "User" AS learner ON learner."id" = denied_entry."userId"
ON CONFLICT ("sessionId", "userId") DO UPDATE
SET "status" = 'DENIED', "decidedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP;

-- Admission is the strongest legacy state and therefore wins any conflict.
INSERT INTO "ClassroomLobbyEntry" (
    "sessionId", "userId", "status", "decidedAt", "createdAt", "updatedAt"
)
SELECT
    session_row."id",
    admitted_entry."userId",
    'ADMITTED'::"ClassroomLobbyStatus",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Session" AS session_row
CROSS JOIN LATERAL (
    SELECT CASE
        WHEN item."value" ~ '^[1-9][0-9]*$'
            AND length(item."value") <= 10
        THEN CASE
            WHEN item."value"::NUMERIC <= 2147483647
            THEN item."value"::INTEGER
        END
    END AS "userId"
    FROM jsonb_array_elements_text(
        CASE
            WHEN jsonb_typeof(session_row."classroomState"->'lobby'->'admitted') = 'array'
            THEN session_row."classroomState"->'lobby'->'admitted'
            ELSE '[]'::JSONB
        END
    ) AS item("value")
) AS admitted_entry
JOIN "User" AS learner ON learner."id" = admitted_entry."userId"
ON CONFLICT ("sessionId", "userId") DO UPDATE
SET "status" = 'ADMITTED', "decidedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP;

-- There must be one source of truth after the backfill.
UPDATE "Session"
SET "classroomState" = "classroomState" - 'lobby'
WHERE jsonb_typeof("classroomState") = 'object' AND "classroomState" ? 'lobby';
