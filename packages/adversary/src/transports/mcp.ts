import { createHash } from "node:crypto";
import {
  applyMergePatch,
  type ChannelOffer,
  canonicalize,
  type IssuedChallenge,
  type McpChannel,
  type ParsedChannels,
  parseWireChannels,
} from "@x402-redteam/schema";
import { readableRequirement } from "../rails/x402v2.js";

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

// ---- wire.channels (U30-4, ADR-032 #5) ---------------------------------------------------

/** A JSON-RPC error answer: HTTP 200, the request `id` echoed, a string `message`, and
 * nothing else in the envelope (the MCP SDK parses error responses strictly, D9). */
export class McpRpcError {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data: unknown,
  ) {}
}

/** The wire spec fields this module reads (the rendered `RenderedChallenge["wire"]`). */
export interface McpWire {
  patch?: Record<string, unknown>;
  channels?: string;
}

/** A valid 1x1 PNG, the non-text first content item of `text_second` (N6). */
const IMAGE_BLOCK = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  mimeType: "image/png",
} as const;

/** A URL elicitation the MCP SDK accepts, for `jsonrpc_elicit`. */
const ELICITATION = {
  mode: "url",
  message: "Authorization required",
  elicitationId: "elicit-1",
  url: "https://elicit.invalid/authorize",
} as const;

export interface ChannelPlan {
  /** The `PaymentRequired` after `wire.patch`. */
  patched: Record<string, unknown>;
  mode: ParsedChannels["mode"];
  /** True when the answer is the spec's result shape with identical copies (`both`). */
  both: boolean;
  /** Each channel that carried a JSON object, as served. */
  served: Partial<Record<McpChannel, Record<string, unknown>>>;
  /** The tool result (every mode but `jsonrpc*`), without the settlement `_meta`. */
  result?: Record<string, unknown>;
  /** The JSON-RPC error (the `jsonrpc*` modes). */
  error?: McpRpcError;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The parsed literal, when it is a plain JSON object. */
function objectOf(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where `wire.channels` puts the `PaymentRequired` (D5, spec table). `typed` is the typed
 * challenge (with an `error` key when the server answers a rejected payment); `wire.patch`
 * is applied to it before it goes into any channel. Pure: the adversary's response, the
 * ledger's issuance and the fuzz manifest's per-channel hashes all derive from this one plan.
 */
export function planChannels(typed: unknown, wire: McpWire): ChannelPlan {
  const parsed = parseWireChannels(wire.channels ?? "both");
  if (parsed === null) throw new Error(`invalid wire.channels "${wire.channels}"`);
  const patched = applyMergePatch(clone(typed), wire.patch ?? {}) as Record<string, unknown>;
  const typedObject = clone(typed) as Record<string, unknown>;
  const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });
  const plan = (
    both: boolean,
    served: ChannelPlan["served"],
    result: Record<string, unknown>,
  ): ChannelPlan => ({ patched, mode: parsed.mode, both, served, result });
  const rpc = (data: unknown): ChannelPlan => ({
    patched,
    mode: parsed.mode,
    both: false,
    served: { error: patched },
    error: new McpRpcError(Number(parsed.arg), "Payment required", data),
  });

  switch (parsed.mode) {
    case "both":
      return plan(
        true,
        { structured: patched, text: patched },
        { content: [text(patched)], structuredContent: patched, isError: true },
      );
    case "structured_only":
      return plan(
        false,
        { structured: patched },
        { content: [], structuredContent: patched, isError: true },
      );
    case "text_only":
      return plan(false, { text: patched }, { content: [text(patched)], isError: true });
    case "text_differs":
      return plan(
        false,
        { structured: patched, text: typedObject },
        { content: [text(typedObject)], structuredContent: patched, isError: true },
      );
    case "structured_differs":
      return plan(
        false,
        { structured: typedObject, text: patched },
        { content: [text(patched)], structuredContent: typedObject, isError: true },
      );
    case "text_second":
      return plan(
        false,
        { text: patched },
        { content: [{ ...IMAGE_BLOCK }, text(patched)], isError: true },
      );
    case "structured_raw": {
      const literal: unknown = JSON.parse(parsed.arg ?? "null");
      const served: ChannelPlan["served"] = { text: patched };
      if (isRecord(literal)) served.structured = literal;
      return plan(false, served, {
        content: [text(patched)],
        structuredContent: literal,
        isError: true,
      });
    }
    case "text_raw": {
      const literal = parsed.arg ?? "";
      const object = objectOf(literal);
      return plan(false, object === undefined ? {} : { text: object }, {
        content: [{ type: "text", text: literal }],
        isError: true,
      });
    }
    case "jsonrpc":
      return rpc(patched);
    case "jsonrpc_ns":
      return rpc({ x402: patched });
    case "jsonrpc_elicit":
      return rpc({ elicitations: [{ ...ELICITATION }], x402: patched });
    case "not_error":
      return plan(
        false,
        { structured: patched, text: patched },
        { content: [text(patched)], structuredContent: patched, isError: false },
      );
  }
}

/** The answer for a plan: the tool result (the settlement response riding in `_meta`) or the
 * JSON-RPC error. A `both` plan is byte-identical to `paymentRequiredResult`. */
export function planAnswer(
  plan: ChannelPlan,
  settlement?: unknown,
): Record<string, unknown> | McpRpcError {
  if (plan.error !== undefined) return plan.error;
  const result = plan.result as Record<string, unknown>;
  return settlement === undefined
    ? result
    : { ...result, _meta: { [MCP_PAYMENT_RESPONSE_META]: settlement } };
}

function readableEntries(accepts: unknown): Record<string, unknown>[] {
  return Array.isArray(accepts)
    ? (accepts.filter(readableRequirement) as unknown as Record<string, unknown>[])
    : [];
}

/** The `channels` of a plan: each served object's `accepts` value, as served (null when
 * the object has none). */
export function planOffers(plan: ChannelPlan): Partial<Record<McpChannel, ChannelOffer>> {
  const out: Partial<Record<McpChannel, ChannelOffer>> = {};
  for (const channel of ["structured", "text", "error"] as const) {
    const object = plan.served[channel];
    if (object !== undefined) {
      out[channel] = { accepts: object.accepts === undefined ? null : object.accepts };
    }
  }
  return out;
}

/** N1: the union of the channels' readable entries in a fixed order (structured, text,
 * error), identical entries once. It never depends on what the client sent. */
export function unionAccepts(
  offers: Partial<Record<McpChannel, ChannelOffer>>,
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const channel of ["structured", "text", "error"] as const) {
    const offer = offers[channel];
    if (offer === undefined) continue;
    for (const entry of readableEntries(offer.accepts)) {
      const key = JSON.stringify(canonicalize(entry));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/**
 * The `IssuedChallenge` of an MCP issuance under a `wire` override (D2, D11). `base` is the
 * rail's plain issuance, kept for its ids. `accepts` is the union of the channels' readable
 * entries, so a client following either channel is matched to an offer that was served. The
 * `wire` record mirrors HTTP's (a patch with `both` records `offered` exactly as HTTP does)
 * with `encoding: "standard"`, since an MCP object has no header encoding, and `channels`
 * is set only when the mode is not `both`.
 */
export function issuedUnderWire(base: IssuedChallenge, plan: ChannelPlan): IssuedChallenge {
  const offers = planOffers(plan);
  const accepts = unionAccepts(offers) as unknown as IssuedChallenge["accepts"];
  const arrays = Object.values(offers).filter((o) => Array.isArray(o.accepts));
  const unreadable = Math.max(
    0,
    ...arrays.map((o) => (o.accepts as unknown[]).length - readableEntries(o.accepts).length),
  );
  const { requirements: _typed, ...rest } = base;
  return {
    ...rest,
    ...(accepts[0] !== undefined ? { requirements: accepts[0] } : {}),
    accepts,
    wire: {
      encoding: "standard",
      parseable: arrays.length > 0,
      unreadable_entries: unreadable,
      offered: plan.patched,
      header_sha256: createHash("sha256").update(JSON.stringify(plan.patched)).digest("hex"),
    },
    ...(plan.both ? {} : { channels: offers }),
  };
}
