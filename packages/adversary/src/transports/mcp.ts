/**
 * The MCP transport layer (U30-1, ADR-034, m7): how an x402 challenge, a payment and a
 * settlement travel in JSON-RPC tool results and `_meta`, per the x402 MCP transport spec
 * (`specs/transports-v2/mcp.md` at the pinned commit). Pure functions: the rail builds and
 * decodes the objects, this module only encodes and extracts.
 */

/** `params._meta` key a client puts its `PaymentPayload` under. */
export const MCP_PAYMENT_META = "x402/payment";
/** `result._meta` key a server puts its `SettleResponse` under. */
export const MCP_PAYMENT_RESPONSE_META = "x402/payment-response";

/** What a `tools/call` carried in `params._meta["x402/payment"]`. */
export type McpCredential =
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "string"; value: string }
  /** Anything else (number, array, null, boolean): recorded as a `decode_error` leg. */
  | { kind: "other"; value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The payment a `tools/call` carries, or null when `params._meta` has no
 * `x402/payment` key. An object goes to the rail's object decoder, a string to the header
 * decoder first, anything else becomes a `decode_error` leg.
 */
export function extractMcpCredential(params: unknown): McpCredential | null {
  if (!isRecord(params) || !isRecord(params._meta)) return null;
  if (!(MCP_PAYMENT_META in params._meta)) return null;
  const value = params._meta[MCP_PAYMENT_META];
  if (typeof value === "string") return { kind: "string", value };
  if (isRecord(value)) return { kind: "object", value };
  return { kind: "other", value };
}

/** A `CallToolResult` as the spec requires for a payment-required answer: `isError: true`,
 * `structuredContent` the `PaymentRequired`, and `content[0].text` its JSON. Both channels
 * carry the same object. `settlement`, when given, rides in `_meta`. */
export function paymentRequiredResult(
  paymentRequired: unknown,
  settlement?: unknown,
): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
    structuredContent: paymentRequired,
    isError: true,
    ...(settlement !== undefined ? { _meta: { [MCP_PAYMENT_RESPONSE_META]: settlement } } : {}),
  };
}

/** A delivered tool result, carrying the settlement response in `_meta`. */
export function deliveryResult(text: string, settlement: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    _meta: { [MCP_PAYMENT_RESPONSE_META]: settlement },
  };
}

/** A tool result with no payment involved (a free tool). */
export function plainResult(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}
