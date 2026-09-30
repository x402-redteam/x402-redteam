import type { Payment } from "@x402-redteam/schema";

/**
 * Relative priority of each single capture layer when two payments sharing a
 * `dedupe_key` merge: whichever side has the lowest-ranked layer contributes
 * `route_key`/`host`/`challenge_id`/`instruction_source`/`replay` to the
 * merged record. `header` always wins (it carries route/host/challenge_id);
 * `rpc` is chain-level but route-agnostic; `shim` is pure self-reported
 * enrichment. A payment's own `capture` may already be a compound label
 * (e.g. an existing `"header+shim"` entry merging against a later, distinct
 * dedupe_key collision), so the rank of a compound label is the best
 * (lowest) rank among its layers.
 */
const LAYER_RANK: Record<string, number> = { header: 0, rpc: 1, shim: 2 };

function rankOf(capture: string): number {
  return Math.min(
    ...capture.split("+").map((layer) => LAYER_RANK[layer] ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * v2 (application-design.md §4 "Merge rule (v2)", ADR-013): the merged `capture` label
 * is the sorted union of the two sides' individual layers, joined with "+" - e.g.
 * `header` + `shim` -> `"header+shim"`, `rpc` + `shim` -> `"rpc+shim"`. A `header` and an
 * `rpc` payment never share a `dedupe_key` (EIP-3009 nonce vs tx hash / message hash), so
 * `"header+rpc"` never occurs in practice.
 */
function mergeCaptureLabel(a: Payment["capture"], b: Payment["capture"]): Payment["capture"] {
  const layers = new Set([...a.split("+"), ...b.split("+")]);
  return [...layers].sort().join("+") as Payment["capture"];
}

/**
 * Pure dedupe-key merge rule, per functional-design.md §4 (application-design.md
 * §4's "Merge rule", amended by the v2 "Merge rule (v2)" for ADR-013's rpc/rpc+shim
 * layers). Merges two captures of the same payment (sharing a `dedupe_key`) into a
 * single entry: the merged `capture` label is the sorted union of layers (see
 * `mergeCaptureLabel`), route/host/challenge_id/instruction_source/replay come from
 * the higher-priority side (see `LAYER_RANK`), and the lower `seq` is kept. A payment
 * with a distinct `dedupe_key` is simply appended, ordered by seq.
 */
export function merge(existing: Payment[], incoming: Payment): Payment[] {
  const idx = existing.findIndex((p) => p.dedupe_key === incoming.dedupe_key);
  if (idx === -1) {
    return [...existing, incoming].sort((a, b) => a.seq - b.seq);
  }

  const current = existing[idx] as Payment;
  const currentWins = rankOf(current.capture) <= rankOf(incoming.capture);
  const primary = currentWins ? current : incoming;
  const secondary = currentWins ? incoming : current;

  const merged: Payment = {
    ...secondary,
    ...primary,
    capture: mergeCaptureLabel(current.capture, incoming.capture),
    seq: Math.min(current.seq, incoming.seq),
    replay: primary.replay,
  };

  const next = [...existing];
  next[idx] = merged;
  return next.sort((a, b) => a.seq - b.seq);
}
