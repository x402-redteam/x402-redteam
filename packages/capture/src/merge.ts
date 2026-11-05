import type { Payment } from "@x402-redteam/schema";

/**
 * Relative priority of each single capture layer when two payments sharing a
 * `dedupe_key` merge: whichever side has the lowest-ranked layer contributes
 * `route_key`/`host`/`challenge_id`/`instruction_source`/`replay` to the
 * merged record. `header` always wins (it carries route/host/challenge_id);
 * `rpc` is chain-level but route-agnostic; `shim` is pure self-reported
 * enrichment; `submitted` (v4) is a signature the agent POSTed to a collect_signature
 * route, which carries the route but never a challenge. A payment's own `capture` may already be a compound label
 * (e.g. an existing `"header+shim"` entry merging against a later, distinct
 * dedupe_key collision), so the rank of a compound label is the best
 * (lowest) rank among its layers.
 */
const LAYER_RANK: Record<string, number> = { header: 0, rpc: 1, shim: 2, submitted: 3 };

function rankOf(capture: string): number {
  return Math.min(
    ...capture.split("+").map((layer) => LAYER_RANK[layer] ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * v2 (application-design.md §4 "Merge rule (v2)", ADR-013): the merged `capture` label
 * is the sorted union of the two sides' individual layers, joined with "+" - e.g.
 * `header` + `shim` -> `"header+shim"`, `rpc` + `shim` -> `"rpc+shim"`. `"header+rpc"` occurs
 * when a signed EIP-3009 authorization (keyed `eip3009:…:<sigKey>`) or an SVM tx (keyed by message
 * hash) arrives in a PAYMENT-SIGNATURE header and is also submitted to a mock RPC.
 */
function mergeCaptureLabel(a: Payment["capture"], b: Payment["capture"]): Payment["capture"] {
  const layers = new Set([...a.split("+"), ...b.split("+")]);
  return [...layers].sort().join("+") as Payment["capture"];
}

/** Strongest reading first (U37, C2): the merged entry keeps the best `terms_verified`
 * whatever the layer rank, so arrival order (a hint-less facilitator leg first) never pins a
 * weaker reading on an honest payment. */
const TERMS_RANK: Record<string, number> = {
  offered: 4,
  offered_domain_only: 3,
  client_copy: 2,
  none: 1,
};

function strongestTerms(
  a: Payment["terms_verified"],
  b: Payment["terms_verified"],
): Payment["terms_verified"] {
  const rank = (t: Payment["terms_verified"]): number =>
    t === undefined ? 0 : (TERMS_RANK[t] ?? 0);
  return rank(b) > rank(a) ? b : a;
}

function sameText(a: string, b: string, chain: string): boolean {
  return chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameAmount(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/** True when two payments sharing a key disagree on who paid whom or how much. A correct key
 * never lets this happen; the guard keeps a future key regression from hiding a payment. */
function conflicts(a: Payment, b: Payment): boolean {
  return (
    a.chain !== b.chain ||
    !sameText(a.from, b.from, a.chain) ||
    !sameText(a.to, b.to, a.chain) ||
    !sameAmount(a.amount_atomic, b.amount_atomic)
  );
}

/**
 * Pure dedupe-key merge rule, per functional-design.md §4 (application-design.md
 * §4's "Merge rule", amended by the v2 "Merge rule (v2)" for ADR-013's rpc/rpc+shim
 * layers). Merges two captures of the same payment (sharing a `dedupe_key`) into a
 * single entry: the merged `capture` label is the sorted union of layers (see
 * `mergeCaptureLabel`), route/host/challenge_id/instruction_source/replay come from
 * the higher-priority side (see `LAYER_RANK`), and the lower `seq` is kept. `terms_verified` keeps the strongest reading of the two sides. A payment
 * with a distinct `dedupe_key` is simply appended, ordered by seq; so is one that shares a key
 * but disagrees on chain, payer, payee or amount (see `conflicts`).
 */

export function merge(existing: Payment[], incoming: Payment): Payment[] {
  const idx = existing.findIndex((p) => p.dedupe_key === incoming.dedupe_key);
  if (idx === -1) {
    return [...existing, incoming].sort((a, b) => a.seq - b.seq);
  }

  const current = existing[idx] as Payment;
  if (conflicts(current, incoming)) {
    // Defensive (U37, C4): append under a disambiguated, still-unique key.
    return [
      ...existing,
      { ...incoming, dedupe_key: `${incoming.dedupe_key}#${incoming.seq}` },
    ].sort((a, b) => a.seq - b.seq);
  }
  const currentWins = rankOf(current.capture) <= rankOf(incoming.capture);
  const primary = currentWins ? current : incoming;
  const secondary = currentWins ? incoming : current;
  const terms_verified = strongestTerms(current.terms_verified, incoming.terms_verified);

  const merged: Payment = {
    ...secondary,
    ...primary,
    capture: mergeCaptureLabel(current.capture, incoming.capture),
    seq: Math.min(current.seq, incoming.seq),
    replay: primary.replay,
    ...(terms_verified !== undefined ? { terms_verified } : {}),
  };

  const next = [...existing];
  next[idx] = merged;
  return next.sort((a, b) => a.seq - b.seq);
}
