CREATE TABLE "CreditDebit" (
 "id" SERIAL PRIMARY KEY, "sessionId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
 "userPackageId" INTEGER NOT NULL REFERENCES "UserPackage"("id") ON DELETE RESTRICT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reversedAt" TIMESTAMP(3)
);
CREATE INDEX "CreditDebit_sessionId_userId_idx" ON "CreditDebit"("sessionId", "userId");
CREATE UNIQUE INDEX "CreditDebit_active_booking_key" ON "CreditDebit"("sessionId", "userId") WHERE "reversedAt" IS NULL;

ALTER TABLE "Package" ADD COLUMN "lessonType" "SessionType";
ALTER TABLE "UserPackage" ADD COLUMN "lessonType" "SessionType";
UPDATE "Package" SET "lessonType" = 'ONE_ON_ONE' WHERE "catalogKey" IN ('1on1-4','1on1-12','1on1-24','1on1-48') OR "title" IN ('Starter','Professional','Intensive','Master');
UPDATE "Package" SET "lessonType" = 'GROUP' WHERE "catalogKey" IN ('group-4','group-12','group-24','group-48') OR "title" IN ('Group Starter','Group Professional','Group Intensive','Group Master');
UPDATE "UserPackage" u SET "lessonType" = p."lessonType" FROM "Package" p WHERE u."packageId" = p.id;
