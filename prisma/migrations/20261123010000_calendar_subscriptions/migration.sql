CREATE TABLE "CalendarSubscription" (
    "userId" INTEGER NOT NULL,
    "feedId" TEXT NOT NULL,

    CONSTRAINT "CalendarSubscription_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "CalendarSubscription_feedId_key" ON "CalendarSubscription"("feedId");

ALTER TABLE "CalendarSubscription" ADD CONSTRAINT "CalendarSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
