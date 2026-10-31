/**
 * Exit classes for one planned call (U33 §3.3, M7, rules 2 and 3). The parent classifies what
 * the child returned; when in doubt the outcome is unmeasured (exit 3).
 *
 * A payment was due when the result has `isError` and a parseable `PaymentRequired` in any
 * channel (`_meta["x402/error"]`, `structuredContent`, or a text content item). The package
 * reads only the first. A challenge that is visible elsewhere but not there is `not-reached`:
 * unmeasured, never a pass. A visible challenge left unpaid is measured only when it matches
 * a known reason below.
 */
import { blockedHost } from "./blocked-host.js";
import { CHALLENGE_META_KEY, type CallResult } from "./protocol.js";

export type Outcome =
  | "no_payment_due"
  | "paid_delivered"
  | "paid_then_error"
  | "declined"
  | "over_cap"
  | "payload_failed"
  | "unpaid_no_offer"
  | "unpaid_over_spend_control"
  | "json_rpc_payment_error"
  | "not_reached"
  | "unexplained";

export interface Verdict {
  kind: "measured" | "unmeasured";
  outcome: Outcome;
  reason: string;
  /** Where a parseable PaymentRequired was visible in the result. */
  channels: { meta: boolean; structured: boolean; text: boolean };
}

/** The per-payment spend control the package's client applies by default: $1 of a
 * 6-decimal asset (CLAUDE.md, known SDK facts). */
export const DEFAULT_SPEND_CAP_ATOMIC = 1_000_000n;

/** JSON-RPC codes that mean "payment required" on the MCP transport. */
const PAYMENT_RPC_CODES = new Set([402, -32042]);

const NO_CHANNELS = { meta: false, structured: false, text: false };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** True when `value` is a parseable `PaymentRequired`: an object with a non-empty `accepts`. */
function isPaymentRequired(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && Array.isArray(record.accepts) && record.accepts.length > 0;
}

/** The text items of a result's content, in order. */
export function contentTexts(result: Record<string, unknown>): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.flatMap((item) => {
    const record = asRecord(item);
    return record !== undefined && typeof record.text === "string" ? [record.text] : [];
  });
}

/** Which channels of a tool result carry a parseable PaymentRequired. */
export function visibleChannels(result: Record<string, unknown>): Verdict["channels"] {
  return {
    meta: isPaymentRequired(asRecord(result._meta)?.[CHALLENGE_META_KEY]),
    structured: isPaymentRequired(result.structuredContent),
    text: contentTexts(result).some((t) => isPaymentRequired(parseJson(t))),
  };
}

/** What the unpaid challenge in `_meta` offered, when it explains why nothing was signed. */
function unpaidOfferReason(meta: unknown): Outcome | undefined {
  const accepts = asRecord(meta)?.accepts;
  if (!Array.isArray(accepts)) return undefined;
  const exactEvm = accepts.flatMap((a) => {
    const r = asRecord(a);
    return r !== undefined &&
      r.scheme === "exact" &&
      typeof r.network === "string" &&
      r.network.startsWith("eip155:")
      ? [r]
      : [];
  });
  if (exactEvm.length === 0) return "unpaid_no_offer";
  const allOver = exactEvm.every((r) => {
    if (typeof r.amount !== "string" || !/^[0-9]+$/.test(r.amount)) return false;
    return BigInt(r.amount) > DEFAULT_SPEND_CAP_ATOMIC;
  });
  return allOver ? "unpaid_over_spend_control" : undefined;
}

const KNOWN_TEXT = {
  declined: "User declined payment",
  payload: "Failed to create payment payload",
  cap: "Payment exceeds client cap",
} as const;

export function classifyCall(call: CallResult, taskHosts: Set<string>): Verdict {
  const unmeasured = (outcome: Outcome, reason: string, channels = NO_CHANNELS): Verdict => ({
    kind: "unmeasured",
    outcome,
    reason,
    channels,
  });
  const measured = (outcome: Outcome, reason: string, channels = NO_CHANNELS): Verdict => ({
    kind: "measured",
    outcome,
    reason,
    channels,
  });

  if (call.thrown !== undefined) {
    const { name, message, code } = call.thrown;
    const blocked = blockedHost(message);
    if (blocked !== undefined && taskHosts.has(blocked.toLowerCase())) {
      return unmeasured("unexplained", `the guard refused a task host (${blocked})`);
    }
    if (call.signed === 0 && name === "McpError" && code !== undefined && PAYMENT_RPC_CODES.has(code)) {
      return measured("json_rpc_payment_error", `JSON-RPC payment-required error ${code} thrown`);
    }
    return unmeasured("unexplained", `callTool threw ${name}: ${message.slice(0, 200)}`);
  }

  const result = asRecord(call.result);
  if (result === undefined) return unmeasured("unexplained", "the call returned no result object");
  const channels = visibleChannels(result);
  const isError = result.isError === true;

  if (call.signed > 0) {
    return isError
      ? measured("paid_then_error", "a payment was signed; the final result is an error", channels)
      : measured("paid_delivered", "a payment was signed; the final result is not an error", channels);
  }

  if (!isError) {
    if (channels.meta || channels.structured || channels.text) {
      return unmeasured(
        "unexplained",
        "a challenge is visible in a result without isError; no payment was due by the rule",
        channels,
      );
    }
    return measured("no_payment_due", "the result is not an error and carries no challenge", channels);
  }

  // isError, nothing signed.
  const texts = contentTexts(result);
  const only = texts.length === 1 ? texts[0] : undefined;
  if (only === KNOWN_TEXT.declined) {
    return call.decisions.length > 0 && call.decisions.every((d) => !d)
      ? measured("declined", "the approval callback declined", channels)
      : unmeasured("unexplained", "a decline message without a declining callback", channels);
  }
  if (only === KNOWN_TEXT.payload) {
    return measured("payload_failed", "the package could not create a payment payload", channels);
  }
  if (only?.startsWith(`${KNOWN_TEXT.cap}: `)) {
    return measured("over_cap", "the offer was over the client cap", channels);
  }

  if (channels.meta) {
    const meta = asRecord(result._meta)?.[CHALLENGE_META_KEY];
    const reason = unpaidOfferReason(meta);
    if (reason === "unpaid_no_offer") {
      return measured(reason, "no exact-scheme offer on an eip155 network was made", channels);
    }
    if (reason === "unpaid_over_spend_control") {
      return measured(
        reason,
        `every exact offer is over ${DEFAULT_SPEND_CAP_ATOMIC} atomic, the default per-payment spend control`,
        channels,
      );
    }
    return unmeasured("unexplained", "a visible challenge was left unpaid with no known reason", channels);
  }
  if (channels.structured || channels.text) {
    return unmeasured(
      "not_reached",
      "the challenge is not in result _meta, the channel the client reads (run option off?)",
      channels,
    );
  }
  return unmeasured("unexplained", "an error result with no challenge in any channel", channels);
}
