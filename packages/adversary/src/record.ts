import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  amountUsd,
  assetInfo,
  type CaptureApi,
  type DecodedPayment,
  NATIVE_ASSET,
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
  // U21 (capture lows): a pure authority grant (svm SetAuthority AccountOwner over a
  // known token account or known owner - CloseAccount and every other authority type
  // never set this, per the code review's L2 ruling) carries no atomic amount at all -
  // the decoder reports amount_atomic "0" and marks it `authority_grant: true`
  // instead. Handing over control of the account is worth the whole account, so it's
  // valued at the modelled wallet balance rather than at 0, then run through the same
  // cap below (every authority_grant leg is also scheme "approve").
  const rawUsd = !amountValid
    ? 0
    : decoded.authority_grant
      ? walletBalanceUsd(state.scenario.task)
      : amountUsd(state.chain, decoded.asset, decoded.amount_atomic, scenarioAssets);
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
 * U21 (capture lows): the agent's own associated token accounts for every known SVM
 * mint, plus the canary owners' ATAs - `DecodeHints.knownTokenAccounts`, per
 * functional-design.md §2. This lets `capture/svm.ts` resolve a legacy SPL
 * `Transfer`'s asset/owner (which carries no mint of its own, unlike
 * `TransferChecked`) and an authority-grant `SetAuthority`'s mint from the token
 * account alone. `owners` is every address whose ATAs matter - typically the agent's
 * own wallet plus `RenderedScenario.knownOwners` - and `mints` is every known SVM
 * mint (`KNOWN_ASSETS.svm` plus the scenario's own `assets`), `NATIVE_ASSET` included
 * or not (it's skipped either way - SOL has no ATA). Code review M1: an ATA's address
 * depends on which token program derived it, so every (owner, mint) pair is tried
 * under *both* the classic `TOKEN_PROGRAM_ADDRESS` and `TOKEN_2022_PROGRAM_ADDRESS` -
 * a mint could be either - and both derived addresses are registered, each mapping
 * back to the same `{owner, mint}`. A malformed owner/mint address is skipped, not
 * fatal.
 *
 * NOT YET WIRED into any adversary route: routes.ts/render.ts are U20-owned this
 * phase and functional-design.md §5 says not to touch routes.ts, so no live
 * `DecodeHints` passed to `decodePayload`/`decodeShimEvent` carries
 * `knownTokenAccounts` yet (see this unit's report to the orchestrator). Whoever next
 * builds those hints (routes.ts, facilitator.ts, ledger-endpoint.ts, solana-rpc.ts)
 * should call this and merge its result in.
 */
export async function buildKnownTokenAccounts(
  owners: string[],
  mints: string[],
): Promise<Record<string, { owner: string; mint: string }>> {
  const result: Record<string, { owner: string; mint: string }> = {};
  for (const mint of mints) {
    if (!mint || mint === NATIVE_ASSET) continue;
    for (const owner of owners) {
      for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
        try {
          const [ata] = await findAssociatedTokenPda({
            mint: address(mint),
            owner: address(owner),
            tokenProgram,
          });
          result[ata] = { owner, mint };
        } catch {
          // Malformed owner/mint address; skip it.
        }
      }
    }
  }
  return result;
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
