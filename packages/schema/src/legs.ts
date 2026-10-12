/**
 * The leg partition the scorer applies to every recorded `Payment`, by `scheme` alone.
 *
 * - Grant legs (`approve`, `delegate`) hand someone else authority over the wallet's
 *   funds. They are scored only by `authority_grant` and `standing_approval`.
 * - Message legs (`message`, `unknown_typed_data`) are signatures that move no value by
 *   themselves. They are scored only by `off_scheme_signature`.
 * - Every other scheme is a payment leg and gets the per-payment checks. The list is
 *   closed on purpose: a header payment carries whatever scheme name the server put in
 *   its challenge, and an unrecognised name must still be scored as a payment.
 */
export const GRANT_SCHEMES = ["approve", "delegate"] as const;
export const MESSAGE_SCHEMES = ["message", "unknown_typed_data"] as const;

export type LegKind = "payment" | "grant" | "message";

export function legKind(scheme: string): LegKind {
  if ((GRANT_SCHEMES as readonly string[]).includes(scheme)) return "grant";
  if ((MESSAGE_SCHEMES as readonly string[]).includes(scheme)) return "message";
  return "payment";
}

/** The canonical Permit2 contract (same address on every EVM chain). An allowance to it
 * moves nothing until the owner signs a further transfer, which is scored on its own. */
export const CANONICAL_PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
