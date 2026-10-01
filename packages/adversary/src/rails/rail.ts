import type {
  AssetSpec,
  CaptureApi,
  Chain,
  DecodedPayment,
  DecodeHints,
  IssuedChallenge,
  Rail as RailId,
} from "@x402-redteam/schema";
import type { RenderedRoute } from "../render.js";

/**
 * Protocol adapter interface, per ADR-014 (full) §1 and functional-design.md §2. Every
 * payment-challenge protocol the harness speaks (x402 v2 now; x402 v1 and MPP designed,
 * not built - rails/index.ts) implements this. `routes.ts` and `facilitator.ts` know
 * only this shape; every wire-format detail (header names, body shapes, binding
 * semantics) lives inside one rail implementation.
 *
 * **Known limits (Bolt 6; explicitly Bolt 7 work):**
 * - Push-mode credentials (the client broadcasts its own transaction/signature and the
 *   rail only verifies it after the fact, rather than the harness settling a pull-mode
 *   authorization) are not modeled here - `settle()` always assumes the harness itself
 *   produced the on-chain effect.
 * - Stateful `session` rails (MPP's `intent: "session"` - a challenge that opens a
 *   running balance rather than charging once) are out of scope; every `Rail` here is
 *   one-shot challenge/credential/settle per request.
 */

/** Everything a `Rail.issue()` needs to build one 402 response for a challenged route. */
export interface IssueCtx {
  route: RenderedRoute;
  chain: Chain;
  seed: string;
  scenarioAssets?: AssetSpec[];
  /** The real, physical request URL (may differ from the rendered `resource_url` override). */
  url: string;
  /** This route's next challenge id (route/runtime bookkeeping stays in routes.ts). */
  challenge_id: string;
  /** The shared, run-wide sequence counter's next value (ADR-013). */
  seq: number;
}

export interface IssueResult {
  status: 402;
  headers: Record<string, string>;
  body: unknown;
  /** >= 1 entry - MPP may issue several challenges in one 402; x402v2 issues exactly one. */
  issued: IssuedChallenge[];
}

/** Opaque, rail-owned shape of whatever a request's credential header(s) decoded to -
 * only the rail that produced it knows how to turn this into `DecodedPayment`s. */
export interface RawCredential {
  raw: unknown;
}

export interface DecodeCtx {
  capture: CaptureApi;
  hints?: DecodeHints;
  /** Every challenge issued so far this run, for the binding check. */
  challenges: IssuedChallenge[];
  /** Every `IssuedChallenge.challenge_id` from this route's most recent issuance (code
   * review fix 7) - x402v2 always has exactly one; MPP may have several (any of them is
   * a legitimate thing to answer). */
  currentChallengeIds: string[];
  /** The route this request is presumably paying for and the real, physical request
   * URL - so a rail's binding check can compare a credential's own echoed
   * resource/location terms (e.g. x402v2's `payload.resource.url`) against what this
   * exact issuance would have advertised, without the harness persisting that URL
   * anywhere (code review fix 2: recomputed, not stored, since it's a pure function of
   * (route, url) - identical both times this exact route is hit). */
  route: RenderedRoute;
  url: string;
}

/**
 * Generic "does this credential's echoed terms match what was issued" result (ADR-014
 * §3) - serves MPP's `id`/HMAC, x402's `accepted` echo, and a future tampered-credential
 * scenario off the same field.
 */
export interface BindingResult {
  /** The issued challenge id the credential echoed/was checked against, or `null` when
   * it echoed none (e.g. no challenge had been issued yet for this request). */
  challenge_ref: string | null;
  matches: boolean;
  reason?: string;
}

export interface DecodeResult {
  legs: DecodedPayment[];
  binding: BindingResult;
}

export interface SettleCtx {
  success: boolean;
  network: string;
  payer: string;
  transaction: string;
  errorReason?: string;
}

export interface Rail {
  id: RailId;
  /** Builds the 402 response for a challenged route. Pure given its inputs. */
  issue(ctx: IssueCtx): IssueResult;
  /** Pulls this rail's credential out of a request, or `null` when none is present -
   * header name(s) (or other wire location) are entirely rail-owned. */
  extract(req: Request): RawCredential | null;
  /** Decodes a raw credential into its payment leg(s) and checks it against what was
   * issued. Rejects (throws) when the credential can't be decoded at all (malformed
   * header, unrecognized payload shape) - the caller treats that as one undifferentiated
   * `invalid_payment` outcome, same as today. */
  decode(raw: RawCredential, ctx: DecodeCtx): Promise<DecodeResult>;
  /** Builds the settlement response header(s) (`PAYMENT-RESPONSE` / `Payment-Receipt`). */
  settle(result: SettleCtx): Record<string, string>;
}
