const REVIEW_RESOURCE_STRING_FIELDS = [
  "title",
  "description",
  "kind",
  "sourceType",
  "fileUrl",
  "fileName",
  "externalUrl",
  "googleSlidesUrl",
  "youtubeUrl",
];

const REVIEW_RESOURCE_MAX_LENGTHS = {
  title: 300,
  description: 4000,
  kind: 100,
  sourceType: 100,
  fileUrl: 3000,
  fileName: 300,
  externalUrl: 3000,
  googleSlidesUrl: 3000,
  youtubeUrl: 3000,
};

export function isSessionReviewAvailable(session, now = new Date()) {
  if (!session || session.status === "canceled") return false;
  if (session.status === "completed") return true;
  if (session.status !== "scheduled" || !session.endAt) return false;

  const endAt = new Date(session.endAt).getTime();
  const nowAt = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(endAt) && Number.isFinite(nowAt) && endAt <= nowAt;
}

export function parseSessionResources(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function sanitizeReviewResourceSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const snapshot = {};
  for (const field of REVIEW_RESOURCE_STRING_FIELDS) {
    if (typeof value[field] !== "string") continue;
    const text = value[field].trim();
    if (!text) continue;
    snapshot[field] = text.slice(0, REVIEW_RESOURCE_MAX_LENGTHS[field]);
  }

  if (value.classroomUpload === true) snapshot.classroomUpload = true;
  return Object.keys(snapshot).length ? snapshot : null;
}

export function normalizeReviewResources(resourcesUsed, resourcesUsedAt = {}) {
  const seen = new Set();
  const normalized = [];

  for (const raw of parseSessionResources(resourcesUsed)) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    const rawId = source?.id ?? source?._id ?? source?.resourceId ?? raw;
    const id = typeof rawId === "string" || typeof rawId === "number"
      ? String(rawId).trim().slice(0, 300)
      : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = typeof source?.title === "string"
      ? source.title.trim().slice(0, 300) || null
      : null;
    const openedAt = source?.firstOpenedAt || resourcesUsedAt?.[id] || null;
    const firstOpenedAt = openedAt && !Number.isNaN(new Date(openedAt).getTime())
      ? new Date(openedAt).toISOString()
      : null;

    normalized.push({
      id,
      title,
      firstOpenedAt,
      snapshot: sanitizeReviewResourceSnapshot(source?.snapshot),
    });
  }

  return normalized;
}
