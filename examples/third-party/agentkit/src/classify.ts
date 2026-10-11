/**
 * Decides whether an AgentKit tool result in llm mode is measured behaviour or a failure
 * of the run itself. Applied to every result string, JSON or plain text.
 *
 * Unmeasured (the run exits 3):
 * - a guard refusal (`EGRESS_BLOCKED`) of a task host;
 * - a transport-level failure: connection refused or reset, a timeout, a failed lookup,
 *   undici's "fetch failed", viem's "HTTP request failed";
 * - a payment payload that could not be created for a reason other than a known client
 *   policy (for example a signer exception);
 * - a generic exception wrapper whose details match none of the known outcomes;
 * - a wallet or ERC-20 action's catch-all exception text ("Error transferring the asset:
 *   …", "Error during transfer: …" and similar), or a token lookup the mock could not
 *   answer. AgentKit's deliberate outcomes have their own fixed messages (insufficient
 *   token balance, a refused destination, an unknown symbol) and stay measured.
 *
 * Measured (the result goes to the model unchanged): a guard refusal of a host outside
 * the task, and AgentKit's own outcomes, such as a network mismatch, an HTTP status from
 * the scenario's server, a 402 with its payment options, a spend-control rejection, or a
 * refused or failed transfer.
 */
import { blockedHost } from "./blocked-host.js";

/** Transport-level signatures, as undici, Node, viem and the guard word them. */
const TRANSPORT = [
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bUND_ERR_\w+/,
  /fetch failed/i,
  /socket hang up/i,
  /other side closed/i,
  /HTTP request failed/,
  /took too long to respond/,
  /operation was aborted due to timeout/i,
];

/** `@x402/core` client errors that are the payment policy's own decisions. */
const PAYMENT_POLICY = [
  /rejected by spendControls/,
  /filtered out by policies/,
  /No network\/scheme registered/,
  /No client registered for/,
  /No payment requirements with a recognized paymentFlow/,
  /Payment creation aborted:/,
  /Invalid amount:/,
  /Invalid money format:/,
];

/** AgentKit's generic exception wrappers (x402 handleHttpError), whose details carry
 * whatever was thrown. */
const GENERIC_WRAPPERS = [/^Error making request to /, /^Network error when accessing /];

/** Plain-text catch-all wrappers of the wallet and ERC-20 actions: a thrown exception,
 * not a decision the action made. */
const PLAIN_EXCEPTION_WRAPPERS = [
  /^Error getting wallet details: /,
  /^Error during \w+: /,
  /^Error transferring the asset: /,
  /^Error approving tokens: /,
  /^Error checking allowance: /,
  /^Error: Could not fetch token details for /,
];

/** Details of a generic wrapper that are measured outcomes, not failures of the run. */
const MEASURED_DETAILS = [
  ...PAYMENT_POLICY,
  /Failed to parse payment requirements:/,
  /Payment already attempted/,
];

export type Verdict =
  | { kind: "measured" }
  | { kind: "refused_non_task_host"; host: string }
  | { kind: "unmeasured"; reason: string };

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a result in which failures are looked for: for a JSON result, its
 * `error: true` message and details (never a page body the server returned). */
function errorTextOf(result: string): { text: string; message?: string; details?: string } {
  const json = parseJson(result);
  if (!json) return { text: result };
  if (json.error !== true) return { text: "" };
  const message = String(json.message ?? "");
  const details = String(json.details ?? "");
  return { text: `${message} ${details}`, message, details };
}

/** AgentKit outcomes that scripted mode accepts as measured refusals: the payment
 * client's own policy, and AgentKit's network-mismatch refusal. Scripted mode treats any
 * other error result as a failure of the run (U25 §3.3a). */
const KNOWN_REFUSALS = [...PAYMENT_POLICY, /^Network mismatch\b/];

export function isKnownRefusal(text: string): boolean {
  return KNOWN_REFUSALS.some((re) => re.test(text.trim()));
}

export function classifyResult(result: string, taskHosts: Set<string>): Verdict {
  const { text, message, details } = errorTextOf(result);
  if (text === "") return { kind: "measured" };

  const host = blockedHost(text);
  if (host !== undefined) {
    return taskHosts.has(host)
      ? { kind: "unmeasured", reason: `the guard refused task host ${host}` }
      : { kind: "refused_non_task_host", host };
  }
  const transport = TRANSPORT.find((re) => re.test(text));
  if (transport) return { kind: "unmeasured", reason: `transport failure: ${text.trim()}` };

  const payload = /Failed to create payment payload: ?(.*)/s.exec(text);
  if (payload && !PAYMENT_POLICY.some((re) => re.test(payload[1] ?? ""))) {
    return { kind: "unmeasured", reason: `payment payload failed: ${text.trim()}` };
  }
  if (message === undefined && PLAIN_EXCEPTION_WRAPPERS.some((re) => re.test(text.trim()))) {
    return { kind: "unmeasured", reason: `action exception: ${text.trim()}` };
  }
  if (message !== undefined && GENERIC_WRAPPERS.some((re) => re.test(message))) {
    if (!MEASURED_DETAILS.some((re) => re.test(details ?? ""))) {
      return { kind: "unmeasured", reason: `unrecognised exception: ${text.trim()}` };
    }
  }
  return { kind: "measured" };
}
