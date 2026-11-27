// src/webrtcSignaling/classroomEventPolicy.js
//
// The classroom socket relays events between participants. Clients must never
// be trusted to describe themselves: every relayed event is stamped with the
// sender identity the server authenticated at join time, teacher-only control
// events from anyone else are dropped, and chat events are rebuilt from the
// persisted database row instead of the client-supplied payload.

export const PRIVILEGED_CLASSROOM_ROLES = new Set(["teacher", "admin"]);

// Events that steer everyone else's classroom. Only the session teacher (or an
// admin) may emit them.
export const TEACHER_ONLY_CLASSROOM_EVENTS = new Set([
  "CLASSROOM_LOCK",
  "SET_RESOURCE",
  "LAYOUT_STATE",
  "CONTENT_SCROLL",
  "TEACHER_POINTER_MOVE",
  "TEACHER_POINTER_HIDE",
  "SCREEN_SHARE_ALLOW",
  "PDF_SET_PAGE",
  "PDF_SCROLL",
  "PDF_FIT_TO_PAGE",
  "AUDIO_STATE",
  "AUDIO_PLAY",
  "AUDIO_PAUSE",
  "AUDIO_SEEK",
  "AUDIO_TRACK",
  "LOBBY_ADMITTED",
  "LOBBY_DENIED",
  "LOBBY_ADMIT_ALL",
  "SESSION_NOTES_UPDATE",
  "MODERATION_MUTE",
  "MODERATION_REMOVE",
  "VIDEO_PARTICIPANT_REQUEST",
  "SCREEN_RTC_STOP_REQUEST",
]);

const MODERATION_MEDIA = new Set(["audio", "video"]);

function parsePositiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export const SENDER_STAMP_KEY = "_from";

export function isPrivilegedClassroomRole(role) {
  return PRIVILEGED_CLASSROOM_ROLES.has(String(role || ""));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns a copy of `event` stamped with the authenticated sender, or null when
 * the sender is not allowed to emit it. Pure and synchronous.
 */
export function stampClassroomEvent(event, sender) {
  if (!isPlainObject(event) || typeof event.type !== "string") return null;
  const role = sender?.role || "learner";

  if (TEACHER_ONLY_CLASSROOM_EVENTS.has(event.type) && !isPrivilegedClassroomRole(role)) {
    return null;
  }

  const stamped = { ...event };
  stamped[SENDER_STAMP_KEY] = { userId: sender?.userId ?? null, role };

  if (event.type === "MODERATION_MUTE") {
    if (!MODERATION_MEDIA.has(event.media)) return null;
    const target = event.targetUserId === "all" ? "all" : parsePositiveId(event.targetUserId);
    if (!target) return null;
    stamped.targetUserId = target;
  }

  if (event.type === "MODERATION_REMOVE") {
    const target = parsePositiveId(event.targetUserId);
    if (!target) return null;
    stamped.targetUserId = target;
  }

  // Links a Jitsi participant id to the authenticated classroom user, so the
  // teacher's moderation controls act on the right person.
  if (event.type === "VIDEO_PARTICIPANT") {
    const participantId = typeof event.participantId === "string" ? event.participantId.trim() : "";
    if (!participantId || participantId.length > 64) return null;
    stamped.participantId = participantId;
    stamped.userId = sender?.userId ?? null;
    stamped.role = role;
  }

  // Screen-share status (older clients still broadcast it) and join/leave
  // notices are about the sender; never let a client describe someone else.
  if (event.type === "SCREEN_SHARE") {
    stamped.sharerId = sender?.userId == null ? "" : String(sender.userId);
  }
  if (event.type === "CHAT_SYSTEM") {
    stamped.role = isPrivilegedClassroomRole(role) ? "teacher" : "learner";
    stamped.name = typeof event.name === "string" ? event.name.slice(0, 120) : "Participant";
  }

  // Typing indicators carry self-described identity; overwrite it.
  if (event.type === "CHAT_TYPING") {
    stamped.senderId = sender?.userId ?? null;
    stamped.role = isPrivilegedClassroomRole(role) ? "teacher" : "learner";
  }

  return stamped;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function chatMessageFromRow(row) {
  return {
    id: row.id,
    type: "message",
    role: row.senderRole || "learner",
    name: row.senderName || "Participant",
    text: row.deletedAt ? "" : row.body,
    at: toIso(row.createdAt),
    senderId: row.senderId ?? null,
    recipientId: row.recipientId ?? null,
    visibility: row.visibility || "public",
    isDeleted: Boolean(row.deletedAt),
    deletedAt: toIso(row.deletedAt),
    deliveryStatus: "sent",
  };
}

const CHAT_ROW_SELECT = {
  id: true,
  sessionId: true,
  senderId: true,
  recipientId: true,
  senderRole: true,
  senderName: true,
  body: true,
  visibility: true,
  deletedAt: true,
  createdAt: true,
};

/**
 * Chat events are only relayed when they describe a row that really exists,
 * and the relayed content comes from that row. Returns the event to relay or
 * null to drop it.
 */
export async function resolveClassroomChatEvent(event, { sessionId, sender, prismaClient }) {
  if (event.type !== "CHAT_MESSAGE" && event.type !== "CHAT_DELETE") return event;

  const messageId = String(
    event.type === "CHAT_DELETE"
      ? event.messageId || event.message?.id || ""
      : event.message?.id || event.id || ""
  ).trim();
  if (!messageId || messageId.length > 64) return null;

  const row = await prismaClient.classroomMessage.findUnique({
    where: { id: messageId },
    select: CHAT_ROW_SELECT,
  });
  if (!row || row.sessionId !== sessionId || row.visibility !== "public") return null;

  if (event.type === "CHAT_MESSAGE") {
    if (row.deletedAt || Number(row.senderId) !== Number(sender?.userId)) return null;
    const message = chatMessageFromRow(row);
    return {
      type: "CHAT_MESSAGE",
      sessionId: String(sessionId),
      message,
      id: message.id,
      role: message.role,
      name: message.name,
      text: message.text,
      at: message.at,
      senderId: message.senderId,
      [SENDER_STAMP_KEY]: event[SENDER_STAMP_KEY],
    };
  }

  // CHAT_DELETE: the REST delete endpoint owns authorization; only relay a
  // deletion that has actually been persisted.
  if (!row.deletedAt) return null;
  const message = chatMessageFromRow(row);
  return {
    type: "CHAT_DELETE",
    sessionId: String(sessionId),
    message,
    messageId: message.id,
    at: message.deletedAt,
    [SENDER_STAMP_KEY]: event[SENDER_STAMP_KEY],
  };
}

/**
 * Applies the full policy to a list of public classroom events.
 */
export async function filterClassroomEvents(events, { sessionId, sender, prismaClient, onDrop } = {}) {
  const allowed = [];
  for (const event of events) {
    const stamped = stampClassroomEvent(event, sender);
    if (!stamped) {
      onDrop?.(event, "role");
      continue;
    }
    let resolved = stamped;
    try {
      resolved = await resolveClassroomChatEvent(stamped, { sessionId, sender, prismaClient });
    } catch (err) {
      onDrop?.(event, "lookup_failed", err);
      continue;
    }
    if (!resolved) {
      onDrop?.(event, "unverified_chat");
      continue;
    }
    allowed.push(resolved);
  }
  return allowed;
}

/**
 * A removal is only delivered once the REST lobby/deny call has persisted it,
 * so a removal cannot be faked or race ahead of the lobby state.
 */
export async function isRemovalPersisted(event, { sessionId, prismaClient }) {
  const targetUserId = parsePositiveId(event?.targetUserId);
  if (!sessionId || !targetUserId) return false;
  const entry = await prismaClient.classroomLobbyEntry.findUnique({
    where: { sessionId_userId: { sessionId, userId: targetUserId } },
    select: { status: true },
  });
  return entry?.status === "DENIED";
}
