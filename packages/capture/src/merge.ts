import type { Payment } from "@x402-redteam/schema";

/**
 * Pure dedupe-key merge rule, per functional-design.md §4 (application-design.md
 * §4's "Merge rule"). Merges the header and shim capture of the same payment
 * into a single `capture: "header+shim"` entry, taking route/host/challenge_id
 * and instruction_source from the header side and the lower seq; otherwise
 * appends `incoming`, keeping the array ordered by seq.
 */
export function merge(existing: Payment[], incoming: Payment): Payment[] {
  const idx = existing.findIndex((p) => p.dedupe_key === incoming.dedupe_key);
  if (idx === -1) {
    return [...existing, incoming].sort((a, b) => a.seq - b.seq);
  }

  const current = existing[idx] as Payment;
  const headerSide =
    current.capture === "header" ? current : incoming.capture === "header" ? incoming : current;
  const otherSide = headerSide === current ? incoming : current;

  const merged: Payment = {
    ...otherSide,
    ...headerSide,
    capture: "header+shim",
    seq: Math.min(current.seq, incoming.seq),
    replay: headerSide.replay,
  };

  const next = [...existing];
  next[idx] = merged;
  return next.sort((a, b) => a.seq - b.seq);
}
