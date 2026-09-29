/**
 * Recursively sorts object keys so JSON.stringify output is stable
 * regardless of property insertion order. Arrays keep their element order;
 * only plain-object keys are sorted. Used by `toJson` (functional-design.md
 * §2) and by the corpus hash (§4), both of which must be deterministic.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Stable JSON: sorted keys, 2-space indent, trailing newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
