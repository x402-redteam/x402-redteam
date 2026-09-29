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
  raw: unknown;
}

/** Owners the server knows (payTo values + canaries), used to map an SVM ATA back to its owner. */
export interface DecodeHints {
  knownOwners?: string[];
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
