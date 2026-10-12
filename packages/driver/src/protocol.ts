/**
 * Guardrail Decision Protocol v1 (GDP), per ADR-010 and application-design.md
 * "Contracts (v3, Bolt 6)" / "Guardrail Decision Protocol v1". Re-exported so guardrail
 * authors (`examples/guardrails/**`) can import these types without depending on the
 * driver's runtime (`@x402-redteam/driver/protocol`).
 *
 * Newline-delimited JSON over stdio, one long-lived child process per run. Every
 * message carries an `id`; each request gets exactly one response, or a 5s timeout
 * counts as a deny (driver.ts `gdp.ts`).
 */

export type GdpHook = "payment" | "transfer" | "sign";
export type GdpChain = "evm" | "svm";

/** The subset of `task.json` the driver forwards in `hello` - everything a guardrail
 * needs to judge a request without reading the harness's own task file. */
export interface GdpTaskInfo {
  prompt: string;
  chain: GdpChain;
  network: string;
  budget_usd: number;
  allowed_hosts: string[];
  wallet_address: string;
  wallet_balance_usd: number;
  host_mode: string;
}

export interface GdpHelloRequest {
  id: number;
  type: "hello";
  gdp: 1;
  task: GdpTaskInfo;
}

/** A guardrail implements any non-empty subset of the three hooks; an empty/missing
 * `hooks` means the driver never asks it anything (every 402 is paid at the SDK
 * default selection, every direct transfer is sent, per driver loop §3). */
export interface GdpHelloResponse {
  id: number;
  hooks: GdpHook[];
  name: string;
  version: string;
  nondeterministic: boolean;
}

/** `PaymentRequirements`/`PaymentRequired["resource"]` are forwarded verbatim from
 * `@x402/core/http`'s `decodePaymentRequiredHeader` - intentionally untyped here so this
 * module has no runtime dependency on `@x402/core`. */
export interface GdpHistoryEntry {
  url: string;
  amount_usd: number;
  pay_to: string;
  network: string;
  asset: string;
}

export interface GdpPaymentRequest {
  id: number;
  type: "payment";
  request: { url: string; method: string };
  referrer: { url: string; text: string } | null;
  rail: "x402v2";
  challenge: { accepts: unknown[]; resource: unknown; raw_body: unknown };
  history: GdpHistoryEntry[];
}

export interface GdpAllowPayment {
  id: number;
  decision: "allow";
  accept_index: number;
}

export interface GdpDeny {
  id: number;
  decision: "deny";
  reason: string;
}

export type GdpPaymentResponse = GdpAllowPayment | GdpDeny;

export interface GdpTransferIntentWire {
  to: string;
  amount_usd: number;
  asset: string;
  chain: GdpChain;
}

export interface GdpTransferRequest {
  id: number;
  type: "transfer";
  intent: GdpTransferIntentWire;
  source: { url: string; text: string };
}

export interface GdpAllow {
  id: number;
  decision: "allow";
}

export type GdpTransferResponse = GdpAllow | GdpDeny;

/**
 * `typed_data` is used for an EVM signature over structured data (EIP-712, e.g. an
 * EIP-3009 `TransferWithAuthorization` or a Permit2 authorization) - its own `domain`,
 * `types`, `primaryType` and `message` fields are exactly what the wallet/SDK was asked
 * to sign, forwarded verbatim (driver's `pay.ts` wraps the signer to capture this).
 *
 * `serialized_tx` carries a raw transaction, for every other case:
 * - `chain: "evm"` (a direct, non-x402 transfer): the `0x`-prefixed hex-encoded signed
 *   raw transaction (viem's `signTransaction` output).
 * - `chain: "svm"` (an x402 payment or a direct transfer): the base64-encoded Solana
 *   wire transaction (`@solana/kit`'s `getBase64EncodedWireTransaction`), signed or - in
 *   the x402-payment path, best-effort - a pre-signature preview of the same encoding.
 */
export type GdpSignPayload =
  | { typed_data: unknown }
  | { serialized_tx: string }
  /** v4 (U26-2): an EIP-7702 authorization tuple - the account would run `address`'s code.
   * `chainId` 0 means every chain. */
  | { authorization: { chainId: number; address: string; nonce: number } }
  /** v4 (U26-2): an EIP-191 personal message. */
  | { message: string }
  /** v4 (U26-2): a raw 32-byte digest, signed as-is (`eth_sign`). It can be the hash of
   * anything, including a transaction or another typed-data message. */
  | { digest: string };

/** v4 (U26-2): why the driver is about to sign. */
export type GdpSignIntent = "payment" | "transfer" | "sign_request";

export interface GdpSignRequest {
  id: number;
  type: "sign";
  chain: GdpChain;
  /** v4 (U26-2), always present from driver@2: `payment` (an x402 challenge the
   * `payment` hook allowed), `transfer` (a direct transfer the `transfer` hook allowed)
   * or `sign_request` (a page or 402 body asked the wallet to sign something that is not
   * a payment). */
  intent?: GdpSignIntent;
  /** The first signing input (GDP v1 field, kept for existing guardrails). */
  payload: GdpSignPayload;
  /** v4 (U26-2), always present from driver@2: every signing input of this one action,
   * in signing order - e.g. a Permit2 transfer plus the EIP-2612 permit or the signed
   * `approve` transaction the SDK adds for a gas-sponsoring extension. */
  payloads?: GdpSignPayload[];
  /** v4 (U26-2): for `sign_request`, the page or 402 body that asked for the signature. */
  source?: { url: string; text: string };
  /** `DecodedPayment[]` from `@x402-redteam/schema` - left untyped here for the same
   * reason as `challenge.accepts` above. One entry per leg the signature(s) decode to,
   * scored exactly as the harness will score them. */
  decoded_legs: unknown[];
}

export type GdpSignResponse = GdpAllow | GdpDeny;

export type GdpRequest = GdpHelloRequest | GdpPaymentRequest | GdpTransferRequest | GdpSignRequest;
export type GdpResponse =
  | GdpHelloResponse
  | GdpPaymentResponse
  | GdpTransferResponse
  | GdpSignResponse;

export function isDeny(res: { decision?: string }): res is GdpDeny {
  return res.decision === "deny";
}
