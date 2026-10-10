import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { IssuedChallenge, Payment } from "./ledger.js";
import type { Chain } from "./scenario.js";

/**
 * Types-only contract shared by U3 (capture/decoders) and U2 (adversary
 * server), per functional-design.md §2 "capture-api.ts". This package does
 * not implement decoders, the server, or scoring - see functional-design.md
 * §4 "Do not".
 */
export interface DecodedPayment {
  chain: Chain;
  network: string;
  scheme: string;
  asset: string;
  from: string;
  to: string;
  amount_atomic: string;
  dedupe_key: string;
  valid: boolean;
  invalid_reason?: string;
  /** svm only: the TransferChecked destination token account */
  to_token_account?: string;
  /** v2 (authorization_lifetime, evm EIP-3009 only): validBefore - validAfter. */
  authorization_seconds?: number;
  /**
   * U10 code review fix (H1): every value-moving (or authority-granting) leg found in one
   * decoded submission, in order - a submission can carry more than one Payment (e.g. an EVM
   * tx with both calldata and non-zero native `value`, or an SVM transaction with several
   * Token instructions). The top-level `DecodedPayment` fields mirror `legs[0]` for callers
   * that only look at a single payment; a caller that wants every leg recorded iterates
   * `legs` instead (each entry has this same shape; nested `legs` on an entry is unused).
   * Optional/absent from a decoder that hasn't been updated to detect multiple legs - such a
   * caller's existing single-payment behaviour is unaffected.
   *
   * Cross-unit note: this file is schema/src/** (U9-A-owned in Bolt 5); added here by U10
   * per an orchestrator-directed code-review fix that needed every decoder's return shape to
   * carry it. Purely additive/optional, so no existing reader breaks.
   */
  legs?: DecodedPayment[];
  /**
   * v3 (ADR-016 capture lows, U21 fills it in): true when this leg grants authority over
   * an account rather than moving value directly (e.g. svm `SetAuthority` over a known
   * token account - AccountOwner/CloseAccount - valued at that account's modelled
   * balance, capped like `approve`). Absent/false for an ordinary value-moving leg.
   */
  authority_grant?: boolean;
  raw: unknown;
}

/** Owners the server knows (payTo values + canaries), used to map an SVM ATA back to its owner. */
export interface DecodeHints {
  knownOwners?: string[];
  /**
   * v3 (ADR-016 capture lows, U21 fills it in): the agent's own associated token
   * accounts for known mints (owner + mint per ATA address), so a plain SPL `Transfer`
   * (which carries no mint, unlike `TransferChecked`) can resolve its asset from its
   * *source* token account when that account is a known ATA, instead of staying
   * `asset: ""` / `asset_known: false`.
   */
  knownTokenAccounts?: Record<string, { owner: string; mint: string }>;
}

export type ShimEvent =
  | {
      kind: "evm_typed_data";
      payload: {
        domain: unknown;
        types: unknown;
        primaryType: string;
        message: unknown;
        signature: string;
        address: string;
      };
    }
  | { kind: "evm_tx"; payload: { serialized: string } }
  | { kind: "svm_tx"; payload: { transaction_base64: string } };

export interface AttributionContext {
  challenges: IssuedChallenge[];
  pageBodies: string[];
  prior: Payment[];
  /**
   * The challenge ids of the latest issuance on the route the payment was sent to.
   * Only header-path captures know this; shim and rpc captures leave it unset.
   * When one of these challenges matches the payment and is unpaid, the payment
   * is attributed to it, ahead of older unpaid challenges with the same terms.
   */
  current_challenge_ids?: string[];
}

export interface CaptureApi {
  /** header path (v1 or v2 payload) */
  decodePayload(payload: PaymentPayload, hints?: DecodeHints): Promise<DecodedPayment>;
  decodeShimEvent(evt: ShimEvent, hints?: DecodeHints): Promise<DecodedPayment>;
  attribute(
    p: DecodedPayment,
    ctx: AttributionContext,
  ): Pick<Payment, "instruction_source" | "challenge_id" | "replay">;
  /** dedupe_key merge -> capture "header+shim" */
  merge(existing: Payment[], incoming: Payment): Payment[];
}

// Re-exported for consumers that only need the wire types alongside this contract.
export type { PaymentPayload, PaymentRequirements };
