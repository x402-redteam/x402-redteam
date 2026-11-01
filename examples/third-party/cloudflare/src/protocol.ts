/**
 * The three profiles (U33 §3.2) and the messages on the fd 3 channel. Imports nothing from
 * the package under test, so the parent can use it.
 */

export const PROFILES = ["default", "raised-cap", "approve"] as const;
export type Profile = (typeof PROFILES)[number];

/** The `raised-cap` profile's per-payment cap: $1.00 in 6-decimal USDC (owner decision, C4). */
export const RAISED_CAP_ATOMIC = 1_000_000n;

/** The key the package reads a payment request from, in a tool result's `_meta`. */
export const CHALLENGE_META_KEY = "x402/error";

/** The route a planned call is reported under: `<host>/mcp#<tool>` (the adversary's route key). */
export function routeKey(server: string, tool: string): string {
  return `${server}/mcp#${tool}`;
}

/** The versions the install must have, taken from package.json. */
export interface Pins {
  agents: string;
  core: string;
  evm: string;
}

/** Parent to child: begin. */
export interface StartArgs {
  profile: Profile;
  /** The MCP endpoint of the planned server. */
  url: string;
  /** The planned server's host name, for route keys in the pre-sign log. */
  server: string;
  /** The plan's stated price in atomic units; null when the plan states none. */
  price_atomic: string | null;
  pins: Pins;
}

/** The child's report once the client is connected and `tools/list` has been read. */
export interface ReadyReport {
  loaded: Pins;
  tools: string[];
}

export interface CallArgs {
  tool: string;
}

/** One offered requirement, as the approval callback saw it. */
export interface SeenAccept {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  amount?: unknown;
  pay_to?: unknown;
}

/** What one planned `callTool` came back with. The parent classifies it (classify.ts). */
export interface CallResult {
  tool: string;
  /** Set when `callTool` threw. */
  thrown?: { name: string; message: string; code?: number };
  /** The tool result as the package returned it (JSON). Absent when `callTool` threw. */
  result?: unknown;
  /** How many payments the account was asked to sign during this call. */
  signed: number;
  /** The accepts lists the approval callback saw, in order (empty without a callback). */
  accepts_seen: SeenAccept[][];
  /** What the approval callback returned, in order. */
  decisions: boolean[];
}

/** One line of the pre-sign log, as the child prints it to stderr. */
export const INTENT_PREFIX = "X402_INTENT ";

export interface Intent {
  route: string;
  pay_to: string | undefined;
  network: string | undefined;
  asset: string | undefined;
  /** A pre-sign value in atomic units. Matching (reconcile.ts) uses route, payTo and network only. */
  value_atomic: string | undefined;
}
