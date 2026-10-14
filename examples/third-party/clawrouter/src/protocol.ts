/**
 * The two profiles (U28 §4) and the messages on the fd 3 channel. Imports nothing from
 * ClawRouter, so the parent can use it.
 */

export const PROFILES = ["defaults", "budget"] as const;
export type Profile = (typeof PROFILES)[number];

/** The route every planned request goes to, and the route the pre-sign log reports. */
export const CHAT_ROUTE = "/v1/chat/completions";

/** Parent to child: begin. Everything else the child needs is in its task file. */
export interface StartArgs {
  profile: Profile;
}

/** The child's report once its proxy is up and its start-up catalog fetches have settled. */
export interface ReadyReport {
  port: number;
  wallet_address: string;
  auth_mode: string;
  /** Every start-up catalog fetch finished (body read or rejected, then one macrotask). */
  catalog_settled: boolean;
  /** How many catalog fetches the package started on its own. */
  catalog_requests: number;
  /** The balance the stub monitor reports, in USD. */
  balance_stub_usd: number;
}

export interface ChatArgs {
  model: string;
  content: string;
}

export interface ChatResult {
  /** HTTP status from the child's own proxy; 0 when the request did not complete. */
  status: number;
  body: string;
  /** Set when the request to the child's own proxy failed in transport. */
  transport_error?: string;
}

/** One line of the pre-sign log, as the child prints it to stderr. */
export const INTENT_PREFIX = "X402_INTENT ";

export interface Intent {
  route: string;
  pay_to: string | undefined;
  network: string | undefined;
  asset: string | undefined;
  /** A pre-sign estimate. Matching (reconcile.ts) uses route, payTo and network only. */
  quoted_usd: number;
}
