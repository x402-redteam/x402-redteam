import { canonicalize } from "@x402-redteam/schema";

export { canonicalize };

/** Stable JSON: sorted keys, 2-space indent, trailing newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
