import { prisma } from "../lib/prisma.js";

export const SESSION_TERMINAL_ERROR_CODE = "SESSION_TERMINAL";

export function isTerminalSessionStatus(status) {
  return status === "completed" || status === "canceled";
}

function terminalSessionError(message) {
  const error = new Error(message);
  error.code = SESSION_TERMINAL_ERROR_CODE;
  return error;
}

export function assertSessionCanBeCanceled(session) {
  if (session?.status === "completed") {
    throw terminalSessionError("Completed sessions cannot be canceled");
  }
}

export function assertSessionCanBeRescheduled(session) {
  if (session?.status !== "scheduled") {
    throw terminalSessionError("Only scheduled sessions can be rescheduled");
  }
}

/**
 * Reschedule only a still-scheduled session. The status predicate makes the
 * service safe against a completion/cancellation race after the route read.
 */
export async function rescheduleScheduledSession(
  sessionId,
  { startAt, endAt },
  db = prisma
) {
  const updated = await db.session.updateMany({
    where: { id: Number(sessionId), status: "scheduled" },
    data: { startAt, endAt },
  });

  if (updated.count !== 1) {
    throw terminalSessionError("Only scheduled sessions can be rescheduled");
  }

  return db.session.findUnique({ where: { id: Number(sessionId) } });
}
