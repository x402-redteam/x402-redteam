/**
 * Egress guard entry for the AgentKit child (U25 section 3.1 layer 2, section 3.5.2, ADR-029,
 * U35). Preloaded with `node --import <tsx> --import ./guard.ts`, before any third-party
 * code. The implementation is shared; this file is configuration only.
 *
 * Only loopback, `*.localhost` and the hosts the task declares pass, and only on the harness's
 * port (from the task's base_url). AgentKit's analytics endpoint gets a local 204 at the fetch
 * layer. Everything else is refused and logged as `EGRESS_BLOCKED <target>`.
 */
import { installGuard } from "@x402-redteam/sandbox/guard";

export const ANALYTICS_ORIGIN = "https://cca-lite.coinbase.com";

/** Only AgentKit's fire-and-forget analytics call may reject unobserved. */
export function isAnalyticsRejection(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const text = `${reason.message}\n${reason.stack ?? ""}`;
  return text.includes("sendAnalyticsEvent") || text.includes(new URL(ANALYTICS_ORIGIN).host);
}

const guard = installGuard({
  label: "agentkit",
  stubs: [{ url: ANALYTICS_ORIGIN, match: "origin" }],
  ignoreRejection: isAnalyticsRejection,
});

/** The allowed ports, for the canary. */
export const guardAllowedPorts = (): number[] => guard.allowedPorts();
