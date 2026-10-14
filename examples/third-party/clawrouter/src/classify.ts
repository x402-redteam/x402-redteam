/**
 * Exit classes for a planned chat request (U28 §5, M1, C3). Keyed on the HTTP status and
 * on where the error came from, not on the package's error types alone:
 *
 * - The package's own refusals carry `error.type` in a JSON body and are classified by it.
 * - An upstream failure is returned to the caller as the upstream's own status and body,
 *   so the harness adversary's responses are matched by status and body shape.
 *
 * When in doubt the outcome is unmeasured (exit 3).
 */
import { blockedHost } from "./blocked-host.js";
import type { ChatResult } from "./protocol.js";

export type Verdict =
  | { kind: "measured"; reason: string }
  | { kind: "unmeasured"; reason: string };

/** The package's own error types that are payment outcomes. */
const LOCAL_MEASURED_TYPES = new Set(["spend_policy_denied", "cost_cap_exceeded", "payment_in_doubt"]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** True when `body` is an x402 payment-required body (a challenge passed through). */
function isChallengeBody(body: Record<string, unknown> | undefined): boolean {
  return (
    body !== undefined &&
    typeof body.x402Version === "number" &&
    Array.isArray(body.accepts) &&
    body.accepts.length > 0
  );
}

export function classifyChat(result: ChatResult, taskHosts: Set<string>): Verdict {
  if (result.transport_error !== undefined) {
    return { kind: "unmeasured", reason: `transport error to the child's own proxy: ${result.transport_error}` };
  }
  const { status, body } = result;

  // A guard refusal of a task host is a harness fault, not a payer outcome.
  const blocked = blockedHost(body);
  if (blocked !== undefined && taskHosts.has(blocked.toLowerCase())) {
    return { kind: "unmeasured", reason: `the guard refused a task host (${blocked})` };
  }

  if (status >= 200 && status < 300) return { kind: "measured", reason: "success" };

  const json = asRecord(parseJson(body));
  const error = asRecord(json?.error);

  // The package's own error objects: {"error": {"type": ..., ...}}.
  if (error !== undefined && typeof error.type === "string") {
    if (LOCAL_MEASURED_TYPES.has(error.type)) {
      return { kind: "measured", reason: `package error ${error.type}` };
    }
    return { kind: "unmeasured", reason: `package error type ${error.type} is not in the table` };
  }

  // Upstream pass-through, matched against the adversary's own responses.
  if (status === 402 && isChallengeBody(json)) {
    return { kind: "measured", reason: "402 challenge passed through" };
  }
  if ((status === 402 || status === 400) && json?.error === "invalid_payment") {
    return { kind: "measured", reason: `${status} invalid_payment` };
  }
  if (status === 404) {
    return { kind: "unmeasured", reason: "404 from the adversary: a scenario or harness fault" };
  }
  if (status === 409 && json?.error === "no_run_loaded") {
    return { kind: "unmeasured", reason: "409 no_run_loaded: a harness fault" };
  }

  // The package could not read the challenge it was given.
  if (body.includes("Failed to parse payment requirements")) {
    return { kind: "measured", reason: "payment parse error" };
  }

  return { kind: "unmeasured", reason: `unrecognised outcome: status ${status}: ${body.slice(0, 200)}` };
}
