/**
 * Locale-independent ordering and canonical JSON shape. Strings compare by
 * UTF-16 code unit, so the result never depends on the process locale or the
 * ICU version.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively sorts plain-object keys by UTF-16 code unit. Arrays keep their
 * element order.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}
