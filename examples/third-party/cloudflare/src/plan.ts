/**
 * The scripted plan (U33 §3.1, m2, C4). Each scenario's `task.prompt` ends with one line
 * that must match exactly:
 *
 *   cloudflare: server=<host> tools=<t1>[,<t2>...] price=<usd|none> role=<control|run>
 *
 * - `server` is a key of `task.mcp_servers` (for example `provider.test`);
 * - `tools` are called once each, in the order written, each through the payment wrapper;
 * - `price` is the task's stated price per call in USD, up to six decimals, or `none`. The
 *   `approve` profile needs one; a plan without a price exits 1 under it;
 * - `role=control` marks the batch's smoke paid control (the gate, gate.ts).
 *
 * Any other line starting with `cloudflare:`, or no such line, is unmeasured (exit 3).
 */
import { UnmeasuredError } from "./errors.js";

export const PLAN_RE =
  /^cloudflare: server=([a-z0-9][a-z0-9.-]{0,62}) tools=([a-z][a-z0-9_]{0,63}(?:,[a-z][a-z0-9_]{0,63}){0,19}) price=(none|[0-9]+(?:\.[0-9]{1,6})?) role=(control|run)$/;

export interface Plan {
  server: string;
  tools: string[];
  /** The stated price in USD as written, or null for `none`. */
  price: string | null;
  role: "control" | "run";
}

/** Parses the plan line. Throws UnmeasuredError (exit 3) for anything else. */
export function parsePlan(prompt: string): Plan {
  const lines = prompt.replace(/\n+$/, "").split("\n");
  const last = lines[lines.length - 1] ?? "";
  for (const line of lines.slice(0, -1)) {
    if (line.startsWith("cloudflare:")) {
      throw new UnmeasuredError("a line starting with cloudflare: that is not the last line");
    }
  }
  const match = PLAN_RE.exec(last);
  if (!match) {
    throw new UnmeasuredError(
      last.startsWith("cloudflare:")
        ? "the cloudflare: plan line does not match the grammar"
        : "the prompt does not end with a cloudflare: plan line",
    );
  }
  if (lines.slice(0, -1).join("\n").trim() === "") {
    throw new UnmeasuredError("the prompt has no text before the plan line");
  }
  const price = match[3] as string;
  return {
    server: match[1] as string,
    tools: (match[2] as string).split(","),
    price: price === "none" ? null : price,
    role: match[4] as "control" | "run",
  };
}
