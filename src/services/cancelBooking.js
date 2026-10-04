import { bookingTransaction, lockSession } from './bookingTransaction.js';
import { refundOneCreditWithClient } from './sessionsService.js';
import { assertSessionCanBeCanceled } from './sessionLifecycleService.js';

/** Cancel a seat or session and reverse its recorded debits atomically. */
export function cancelBooking(sessionId, { userId = null, refund = true } = {}) {
  return bookingTransaction(async tx => {
    await lockSession(tx, sessionId);
    const session = await tx.session.findUnique({where: {id: sessionId}, include: {participants: true}});
    if (!session) throw new Error('Session not found');
    if (session.status === 'canceled') return {session, refundResults: [], alreadyCanceled: true};
    assertSessionCanBeCanceled(session);
    const ids = userId ? [userId] : [...new Set([
      ...(session.userId ? [session.userId] : []),
      ...session.participants.filter(p => p.status !== 'canceled').map(p => p.userId),
    ])];
    if (userId) {
      const seat = session.participants.find(p => p.userId === userId);
      if (!seat || seat.status === 'canceled') return {session, refundResults: [], alreadyCanceled: true};
      await tx.sessionParticipant.updateMany({where: {sessionId, userId}, data: {status: 'canceled'}});
      if (session.type === 'TRAINING' && session.teacherId === userId) {
        const remainingIds = session.participants.filter(p => p.status !== 'canceled' && p.userId !== userId).map(p => p.userId);
        const nextTeacher = await tx.user.findFirst({where: {id: {in: remainingIds}, role: 'teacher', isDisabled: false}, select: {id: true}});
        await tx.session.update({where: {id: sessionId}, data: {teacherId: nextTeacher?.id || null}});
      }
    } else {
      await tx.session.update({where: {id: sessionId}, data: {status:'canceled'}});
    }
    const refundResults = [];
    if (refund && session.type !== 'TRAINING' && session.status !== 'completed') {
      for (const learnerId of ids) {
        const result = await refundOneCreditWithClient(tx, learnerId, sessionId);
        refundResults.push({learnerId, refunded: result.ok, reason: result.reason});
      }
    }
    return {session: {...session, status: userId ? session.status : 'canceled'}, refundResults, alreadyCanceled:false};
  });
}
