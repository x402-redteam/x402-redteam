import type { Chain, Scenario } from "./scenario.js";

/**
 * v3 (ADR-016 contract landing, U15): moved here from `scorer/src/resolve.ts` (which now
 * re-imports it) so schema owns every pure "resolve this contract field against a chain"
 * helper, alongside `challengeForChain`/`acceptsForChain`. No logic change -
 * `authorization_lifetime` is EVM-only today (EIP-3009's `validBefore`/`validAfter` has no
 * SVM equivalent, per `corpus/README.md`), so `chain` is accepted for forward
 * compatibility (a future SVM equivalent) but not yet read.
 */
export function maxAuthorizationSeconds(scenario: Scenario, _chain: Chain): number | undefined {
  return scenario.expected.max_authorization_seconds;
}
