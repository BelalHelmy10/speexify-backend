export const DEFAULT_SCHEDULING_TIME_ZONE = "Africa/Cairo";

export function resolveTimeZone(value, fallback = DEFAULT_SCHEDULING_TIME_ZONE) {
  const candidate = String(value || "").trim() || fallback;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Convert a wall-clock date/time in an IANA timezone to a UTC Date.
 * The conversion is DST-aware and keeps calendar dates independent of the
 * server's own timezone.
 */
export function zonedDateTimeToUtc({
  year,
  month,
  day,
  hour,
  minute = 0,
  second = 0,
  timeZone = DEFAULT_SCHEDULING_TIME_ZONE,
}) {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = targetAsUtc;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = zonedParts(new Date(candidate), resolvedTimeZone);
    const currentAsUtc = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute,
      current.second
    );
    const next = targetAsUtc - (currentAsUtc - targetAsUtc);

    if (next === candidate) return new Date(candidate);
    candidate = next;
  }

  return new Date(candidate);
}
