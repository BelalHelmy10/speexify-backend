import { prisma } from '../lib/prisma.js';

// Serialize capacity changes on the database row, including across API instances.
export async function lockSession(tx, sessionId) {
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${Number(sessionId)} FOR UPDATE`;
}
export async function bookingTransaction(work) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (error) {
      if (error.code !== 'P2034' || attempt >= 3) throw error;
    }
  }
}
