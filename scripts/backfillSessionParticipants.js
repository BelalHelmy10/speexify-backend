// scripts/backfillSessionParticipants.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Fetch sessions that have no participants yet
  const sessions = await prisma.session.findMany({
    where: {
      participants: { none: {} },
    },
    select: {
      id: true,
      userId: true,
    },
  });

  // Keep only legacy sessions that still have a userId
  const legacy = sessions.filter((s) => s.userId !== null);

  if (!legacy.length) {
    console.log("No sessions to backfill. ✅");
    return;
  }

  const rows = legacy.map((s) => ({
    sessionId: s.id,
    userId: s.userId, // non-null by filter above
    status: "booked",
  }));

  const result = await prisma.sessionParticipant.createMany({
    data: rows,
    skipDuplicates: true,
  });

  console.log(
    `Backfill done ✅ Inserted ${result.count} participant rows for ${legacy.length} sessions.`
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
