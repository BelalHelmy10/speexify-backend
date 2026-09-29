export function normalizePhone(value) {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const hasLeadingPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("Enter a valid phone number with 8 to 15 digits");
  }

  return `${hasLeadingPlus ? "+" : ""}${digits}`;
}

export function isValidPhone(value) {
  try {
    return Boolean(normalizePhone(value));
  } catch {
    return false;
  }
}
