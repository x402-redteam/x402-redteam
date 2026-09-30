import {
  amountUsd,
  assetInfo,
  type CaptureApi,
  type DecodedPayment,
  type Payment,
  walletBalanceUsd,
} from "@x402-redteam/schema";
import type { RunState } from "./state.js";

export interface RecordDecodedOptions {
  /** Which capture layer produced this observation. */
  capture: "header" | "shim" | "rpc";
  host?: string;
  route_key?: string;
}

/**
 * The common payment-recording block, factored out of ledger-endpoint.ts per U10
 * functional-design.md §2 ("record.ts"): attributes a decoded payment, computes its
 * asset-aware USD value and `asset_known` flag through `assetInfo()`/`amountUsd()`
 * (application-design.md §3 "v2" Asset registry, scenario-aware via `state.scenario.assets`),
 * builds the Payment record and merges it into `state.payments`.
 *
 * DEVIATION from the functional design's literal signature
 * (`recordDecoded(state, rendered, capture, decoded, {capture, host?, route_key?})`):
 * this drops the unused `rendered` parameter. Nothing this function does needs the
 * rendered scenario - `state.scenario.assets` already carries what `amountUsd`/`assetInfo`
 * need, and `host`/`route_key` (the only other per-route facts a caller might have wanted
 * from `rendered`) are passed explicitly through `opts` instead.
 *
 * Returns the (pre-merge) Payment that was recorded, mirroring the existing
 * ledger-endpoint.ts / facilitator.ts behaviour of reporting the freshly-built
 * `payment_id` even when `merge()` folds it into an already-existing entry.
 */
/** Same non-negative-integer-string check every decoder already applies - repeated here as
 * the one choke point every capture layer goes through (M3, code review). */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

export function recordDecoded(
  state: RunState,
  captureApi: CaptureApi,
  decoded: DecodedPayment,
  opts: RecordDecodedOptions,
): Payment {
  const attribution = captureApi.attribute(decoded, {
    challenges: state.challenges,
    pageBodies: state.pageBodies,
    prior: state.payments,
  });
  const seq = state.nextSeq();
  const scenarioAssets = state.scenario.assets;

  // M3 (code review): clamp defensively here too. Every decoder is expected to have
  // already caught a negative/malformed amount, but recordDecoded is the single place
  // every capture layer (header/shim/rpc) funnels through, so a decoder that misses a
  // case - or a future one that forgets the check - can never slip a bad amount_usd
  // (or a false `valid: true`) into a Payment.
  const amountValid = isNonNegativeIntegerString(decoded.amount_atomic);
  const valid = amountValid && decoded.valid;
  const invalid_reason = amountValid ? decoded.invalid_reason : "negative_amount";
  const rawUsd = amountValid
    ? amountUsd(state.chain, decoded.asset, decoded.amount_atomic, scenarioAssets)
    : 0;
  // An approval (e.g. approve(MAX_UINT256)) can't move more than the wallet holds, so its
  // exposure is capped at the modelled balance (ADR-015). Otherwise ~1e71 leaks into
  // wrong_recipient_usd, notional totals, overpay ratios and violation messages.
  const amount_usd =
    decoded.scheme === "approve" ? Math.min(rawUsd, walletBalanceUsd(state.scenario.task)) : rawUsd;

  const payment: Payment = {
    payment_id: `p${seq}`,
    seq,
    capture: opts.capture,
    chain: state.chain,
    network: decoded.network,
    scheme: decoded.scheme,
    asset: decoded.asset,
    from: decoded.from,
    to: decoded.to,
    amount_atomic: decoded.amount_atomic,
    amount_usd,
    ...(invalid_reason !== undefined ? { invalid_reason } : {}),
    ...(opts.route_key !== undefined ? { route_key: opts.route_key } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    dedupe_key: decoded.dedupe_key,
    instruction_source: attribution.instruction_source,
    challenge_id: attribution.challenge_id,
    replay: attribution.replay,
    valid,
    raw: decoded.raw,
    asset_known: assetInfo(state.chain, decoded.asset, scenarioAssets).known,
    ...(decoded.authorization_seconds !== undefined
      ? { authorization_seconds: decoded.authorization_seconds }
      : {}),
  };

  state.payments = captureApi.merge(state.payments, payment);
  return payment;
}

/**
 * H1 (code review): records every leg of a decoded submission as its own Payment, not just
 * the primary one - see `DecodedPayment.legs`. A decoder that hasn't been updated to detect
 * multiple legs simply omits `legs`, so this degrades to recording `decoded` alone (the
 * pre-H1 behaviour). Returns every recorded Payment, primary leg first.
 */
export function recordDecodedLegs(
  state: RunState,
  captureApi: CaptureApi,
  decoded: DecodedPayment,
  opts: RecordDecodedOptions,
): Payment[] {
  const legs = decoded.legs && decoded.legs.length > 0 ? decoded.legs : [decoded];
  return legs.map((leg) => recordDecoded(state, captureApi, leg, opts));
}
