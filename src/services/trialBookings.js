import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";

export const ACTIVE_STATUSES = ["RESERVED", "CONFIRMED"];
export const DEFAULT_SETTINGS = { leadHours: 12, horizonDays: 14, durationMin: 30, bufferMin: 0 };
export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
export function fail(code, status = 409) { throw Object.assign(new Error(code), { status, code }); }
export const settings = async (db = prisma) => (await db.trialBookingSettings.findUnique({ where: { id: 1 } })) || DEFAULT_SETTINGS;

// Every trial mutation takes the same transaction-scoped PostgreSQL lock. This
// serializes capacity, cancellation, rescheduling and trainer assignment across
// API processes. The database CHECK and UNIQUE constraints remain a backstop.
export async function mutateTrial(work, db = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(73639122)`;
    return work(tx);
  }, { maxWait: 10000, timeout: 15000 });
}

export function publicBooking(row) {
  return { id: row.id, name: row.name, phone: row.phone, locale: row.locale, timezone: row.timezone, status: row.status,
    slot: { id: row.slot.id, startAt: row.slot.startAt, endAt: row.slot.endAt } };
}
export async function findManaged(tx, token) {
  const row = await tx.trialBooking.findUnique({ where: { tokenHash: tokenHash(token) }, include: { slot: true } });
  if (!row || new Date(row.slot.endAt).getTime() + 30 * 86400000 < Date.now()) fail("BOOKING_NOT_FOUND", 404);
  return row;
}
export async function availableSlot(tx, id) {
  const slot = await tx.trialSlot.findUnique({ where: { id } });
  const config = await settings(tx);
  const now = Date.now();
  if (!slot || !slot.enabled || slot.startAt.getTime() < now + config.leadHours * 3600000 || slot.startAt.getTime() > now + config.horizonDays * 86400000 || slot.reservedCount >= slot.capacity) fail("SLOT_UNAVAILABLE");
  return slot;
}
export async function reserveTrial(input, db = prisma) {
  return mutateTrial(async (tx) => {
    const hash = tokenHash(input.token);
    const previous = await tx.trialBooking.findUnique({ where: { tokenHash: hash }, include: { slot: true } });
    if (previous) return { booking: publicBooking(previous), created: false };
    // Old appointments must not block a later booking indefinitely if staff
    // have not yet marked attendance. Their history and status are preserved.
    await tx.trialBooking.updateMany({ where: { activePhone: input.phone, slot: { endAt: { lt: new Date() } } }, data: { activePhone: null } });
    if (await tx.trialBooking.findUnique({ where: { activePhone: input.phone } })) fail("ACTIVE_BOOKING_EXISTS");
    const slot = await availableSlot(tx, input.slotId);
    await tx.trialSlot.update({ where: { id: slot.id }, data: { reservedCount: { increment: 1 } } });
    const row = await tx.trialBooking.create({ data: {
      tokenHash: hash, slotId: slot.id, name: input.name, phone: input.phone,
      activePhone: input.phone, locale: input.locale, timezone: input.timezone,
    }, include: { slot: true } });
    return { booking: publicBooking(row), created: true };
  }, db);
}
export async function changeTrial(input, db = prisma) {
  return mutateTrial(async (tx) => {
    const row = await findManaged(tx, input.token);
    if (input.action === "cancel" && row.status === "CANCELLED") return publicBooking(row);
    if (!ACTIVE_STATUSES.includes(row.status) || row.slot.startAt <= new Date()) fail("BOOKING_CLOSED");
    if (input.action === "reschedule" && input.slotId === row.slotId) return publicBooking(row);
    const next = input.action === "reschedule" ? await availableSlot(tx, input.slotId) : null;
    if (next) await tx.trialSlot.update({ where: { id: next.id }, data: { reservedCount: { increment: 1 } } });
    await tx.trialSlot.update({ where: { id: row.slotId }, data: { reservedCount: { decrement: 1 } } });
    return publicBooking(await tx.trialBooking.update({ where: { id: row.id }, data: next
      ? { slotId: next.id, trainerId: null, status: "RESERVED" }
      : { status: "CANCELLED", activePhone: null, trainerId: null }, include: { slot: true } }));
  }, db);
}

export function localToInstant(date, time, timezone = "Africa/Cairo") {
  const target = `${date}T${time}:00`;
  const wall = Date.parse(`${target}Z`);
  if (!Number.isFinite(wall)) fail("INVALID_DATE", 400);
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const candidates = new Set();
  // Sampling both sides of a transition detects nonexistent/ambiguous local
  // times; neither is silently moved to a different appointment time.
  for (const delta of [-36, 0, 36]) {
    const sample = wall + delta * 3600000;
    const displayed = format.format(new Date(sample)).replace(" ", "T");
    const offset = Date.parse(`${displayed}Z`) - sample;
    const instant = wall - offset;
    if (format.format(new Date(instant)).replace(" ", "T") === target) candidates.add(instant);
  }
  if (candidates.size !== 1) fail("AMBIGUOUS_OR_INVALID_TIME", 400);
  return new Date([...candidates][0]);
}
export function generateSlots(input) {
  const start = localToInstant(input.date, input.startTime);
  const end = localToInstant(input.date, input.endTime);
  if (start <= new Date() || end <= start) fail("INVALID_DATE", 400);
  const slots = [];
  for (let at = start.getTime(); at + input.durationMin * 60000 <= end.getTime(); at += (input.durationMin + input.bufferMin) * 60000) {
    slots.push({ startAt: new Date(at), endAt: new Date(at + input.durationMin * 60000), bufferMin: input.bufferMin, capacity: input.capacity });
  }
  if (!slots.length || slots.length > 96) fail("INVALID_DATE", 400);
  return slots;
}

export async function updateAdminBooking(id, data, db = prisma) {
  return mutateTrial(async (tx) => {
    const row = await tx.trialBooking.findUnique({ where: { id }, include: { slot: true } });
    if (!row) fail("BOOKING_NOT_FOUND", 404);
    const status = data.status || row.status;
    const trainerId = data.trainerId === undefined ? row.trainerId : data.trainerId;
    if (!ACTIVE_STATUSES.includes(row.status) && status !== row.status) fail("BOOKING_CLOSED");
    if (["COMPLETED", "NO_SHOW"].includes(status) && row.slot.endAt > new Date()) fail("SESSION_NOT_FINISHED");
    if (status === "CONFIRMED" && !trainerId) fail("TRAINER_REQUIRED", 400);
    if (trainerId && ACTIVE_STATUSES.includes(status) && (trainerId !== row.trainerId || (status === "CONFIRMED" && row.status !== "CONFIRMED"))) {
      const trainer = await tx.user.findUnique({ where: { id: trainerId } });
      if (!trainer || trainer.role !== "teacher" || trainer.isDisabled) fail("INVALID_TRAINER", 400);
      const end = new Date(row.slot.endAt.getTime() + row.slot.bufferMin * 60000);
      const other = await tx.trialBooking.findMany({ where: { id: { not: id }, trainerId, status: { in: ACTIVE_STATUSES }, slot: { startAt: { lt: end }, endAt: { gt: new Date(row.slot.startAt.getTime() - 60 * 60000) } } }, include: { slot: true } });
      const conflict = other.some((b) => b.slot.endAt.getTime() + b.slot.bufferMin * 60000 > row.slot.startAt.getTime());
      const sessions = await tx.session.findMany({ where: { teacherId: trainerId, status: { not: "canceled" }, startAt: { lt: end }, OR: [{ endAt: { gt: new Date(row.slot.startAt.getTime() - row.slot.bufferMin * 60000) } }, { endAt: null }] }, select: { startAt: true, endAt: true } });
      const sessionConflict = sessions.some((s) => (s.endAt?.getTime() ?? s.startAt.getTime() + 3600000) + row.slot.bufferMin * 60000 > row.slot.startAt.getTime());
      if (conflict || sessionConflict) fail("TRAINER_CONFLICT");
    }
    if (status === "CANCELLED" && row.status !== "CANCELLED") await tx.trialSlot.update({ where: { id: row.slotId }, data: { reservedCount: { decrement: 1 } } });
    return tx.trialBooking.update({ where: { id }, data: { status, trainerId: status === "CANCELLED" ? null : trainerId, ...(data.notes !== undefined ? { notes: data.notes } : {}), ...(!ACTIVE_STATUSES.includes(status) ? { activePhone: null } : {}) }, include: { slot: true, trainer: { select: { id: true, name: true } } } });
  }, db);
}


export async function editTrialSlot(slotId, input, db = prisma) {
  return mutateTrial(async (tx) => {
    const slot = await tx.trialSlot.findUnique({ where: { id: slotId } });
    if (!slot) fail("SLOT_UNAVAILABLE", 404);
    if (input.capacity !== undefined && input.capacity < slot.reservedCount) fail("CAPACITY_BELOW_BOOKINGS");
    const data = { ...(input.capacity !== undefined ? { capacity: input.capacity } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) };
    if (input.schedule) {
      const { date, startTime, durationMin, bufferMin } = input.schedule;
      const startAt = localToInstant(date, startTime);
      const endAt = new Date(startAt.getTime() + durationMin * 60000);
      const changed = +startAt !== +slot.startAt || +endAt !== +slot.endAt || bufferMin !== slot.bufferMin;
      if (changed) {
        if (startAt <= new Date() || startAt > new Date(Date.now() + 90 * 86400000)) fail("INVALID_DATE", 400);
        const occupied = await tx.trialBooking.findMany({ where: { slotId, status: { not: "CANCELLED" } } });
        if (occupied.some((b) => !ACTIVE_STATUSES.includes(b.status)) || (occupied.length && slot.startAt <= new Date())) fail("PAST_SLOT_LOCKED");
        if (occupied.length && !input.acknowledgeBookings) fail("BOOKED_SLOT_CONFIRMATION_REQUIRED");
        const duplicate = await tx.trialSlot.findUnique({ where: { startAt } });
        if (duplicate && duplicate.id !== slotId) fail("SLOT_TIME_EXISTS");
        // Moving an occupied time is an explicit admin operation. Clear its
        // assignments so no trainer is silently moved into a conflicting time.
        if (occupied.length) await tx.trialBooking.updateMany({ where: { slotId, status: { in: ACTIVE_STATUSES } }, data: { status: "RESERVED", trainerId: null } });
        Object.assign(data, { startAt, endAt, bufferMin });
      }
    }
    return tx.trialSlot.update({ where: { id: slotId }, data });
  }, db);
}
