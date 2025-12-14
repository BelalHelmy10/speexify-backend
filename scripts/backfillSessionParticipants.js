// scripts/backfillSessionParticipants.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Find sessions that have a legacy userId but no participant row yet
  const sessions = await prisma.session.findMany({
    where: {
      NOT: { userId: null },
      participants: { none: {} },
    },
    select: {
      id: true,
      userId: true,
    },
  });

  if (!sessions.length) {
    console.log("No sessions to backfill. ✅");
    return;
  }

  const rows = sessions.map((s) => ({
    sessionId: s.id,
    userId: s.userId, // guaranteed non-null by the WHERE clause
    status: "booked",
  }));

  const result = await prisma.sessionParticipant.createMany({
    data: rows,
    skipDuplicates: true,
  });

  console.log(
    `Backfill done ✅ Inserted ${result.count} participant rows for ${sessions.length} sessions.`
  );
}

main()
  .catch((err) => {
    console.error("Backfill failed ❌", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
