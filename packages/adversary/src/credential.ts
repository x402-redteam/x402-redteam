import type { Payment } from "@x402-redteam/schema";
import { knownTokenAccountsFor } from "./known-token-accounts.js";
import type { DecodeCtx, DecodeResult } from "./rails/rail.js";
import { recordDecodedLegs } from "./record.js";
import type { RenderedRoute, RenderedScenario } from "./render.js";
import type { Shared } from "./shared.js";
import type { RouteRuntime, RunState } from "./state.js";

/**
 * What the shared credential pipeline made of one submitted payment (U30-1, m7). The
 * pipeline is transport-free: a transport extracts the credential and supplies `decode`;
 * the answer (HTTP response, MCP tool result) stays with the transport.
 */
export type CredentialOutcome =
  /** Nothing could be read as a payment (or recording threw): answered 400 invalid_payment. */
  | { kind: "undecodable" }
  /** Decoded and recorded, but no valid leg answers the current issuance: never delivered. */
  | { kind: "unmatched"; payments: Payment[] }
  /** A valid leg answers the current issuance. */
  | { kind: "matched"; payments: Payment[]; matchingLeg: Payment };

export interface CredentialInput {
  shared: Shared;
  state: RunState;
  rendered: RenderedScenario;
  route: RenderedRoute;
  host: string;
  runtime: RouteRuntime;
  /** Runs the rail's decoder (header or object) with the pipeline's context. */
  decode: (ctx: DecodeCtx) => Promise<DecodeResult>;
  /** The raw credential, recorded as a `decode_error` leg when decoding or recording throws. */
  fallback: unknown;
  /** The physical URL (HTTP) or advertised resource (MCP) the credential answers. */
  url: string;
  /** Set on a credential that arrived over MCP; stamped on every recorded leg. */
  transport?: "mcp";
}

/**
 * Decode, record and match one submitted credential. This is the block `serveChallenge`
 * ran inline before U30-1, moved unchanged so HTTP behaves identically; see the comments
 * kept below for why each step is where it is.
 */
export async function evaluateCredential(input: CredentialInput): Promise<CredentialOutcome> {
  const { shared, state, rendered, route, host, runtime } = input;
  const transport = input.transport !== undefined ? { transport: input.transport } : {};

  let bindingMismatch: boolean;
  let payments: ReturnType<typeof recordDecodedLegs>;
  try {
    const result = await input.decode({
      capture: shared.capture,
      hints: {
        knownOwners: rendered.knownOwners,
        knownTokenAccounts: await knownTokenAccountsFor(
          rendered,
          state.chain,
          shared.seed,
          state.scenario.assets,
        ),
      },
      challenges: state.challenges,
      currentChallengeIds: runtime.currentChallengeIds,
      route,
      url: input.url,
    });
    // U20 code review fix 6: a rail could in principle decode a credential into zero
    // legs (nothing to record) - treated the same as an undecodable credential, inside
    // this same try/catch, rather than proceeding with an empty `payments` array.
    if (result.legs.length === 0) {
      throw new Error("rail.decode: no legs decoded");
    }
    bindingMismatch = !result.binding.matches;
    // U20 code review fix 1: apply the SAME binding verdict to every recorded leg - a
    // rail's decoder (svm, `decodeEvmTx`) can return several (`DecodedPayment.legs`),
    // and mutating only the un-recorded top-level entry would silently miss them.
    payments = result.legs.flatMap((leg) =>
      recordDecodedLegs(state, shared.capture, leg, {
        capture: "header",
        host,
        route_key: route.route_key,
        bindingMismatch,
        currentChallengeIds: runtime.currentChallengeIds,
        ...transport,
      }),
    );
  } catch {
    // U29-0: nothing received is dropped. If recording threw, record a decode_error leg.
    try {
      const stand = await shared.capture.decodePayload(input.fallback);
      recordDecodedLegs(state, shared.capture, stand, {
        capture: "header",
        host,
        route_key: route.route_key,
        ...transport,
      });
    } catch {
      // Nothing more can be recorded; the caller's 400 still stands.
    }
    return { kind: "undecodable" };
  }

  // U29-0: a payload that could not be decoded is on the ledger but is answered exactly as
  // it was before it was recorded: 400 invalid_payment.
  if (payments.length > 0 && payments.every((p) => p.invalid_reason === "decode_error")) {
    return { kind: "undecodable" };
  }

  // Delivery depends specifically on a leg that satisfies THIS issuance, not merely on
  // whether the submission decoded validly - a submission can be a validly signed,
  // on-chain-valid transaction that also happens to bundle in an unrelated (e.g.
  // attacker-directed) leg alongside the legitimate one. U20 code review fix 7: "this
  // issuance" is every id `runtime.currentChallengeIds` carries (MPP may have offered
  // several), not only the first.
  //
  // DEVIATION (reported): fix 7 also suggested falling back to the rail's own binding
  // verdict (`binding.challenge_ref`) when attribution's own match didn't resolve one.
  // Dropped after it broke `replay`/`retry_storm`'s byte-identity: x402v2's binding
  // check (fix 2) matches a credential's echoed `accepted` against the issuance's
  // *accepts content*, which is identical on every re-issuance of the same route (the
  // challenge is deterministic) - so `binding.matches` is true for a stale/replayed
  // resubmission too, and the fallback then picked `payments.find(p => p.valid)`
  // (the first valid leg, regardless of which challenge attribution actually bound it
  // to), wrongly letting a replay satisfy a fresh issuance. Attribution's own
  // challenge_id match (capture/attribute.ts, unchanged) is the sole source of truth
  // for "which challenge does this answer" - exactly as before this rail port.
  const matchingLeg = payments.find(
    (p) => p.challenge_id !== undefined && runtime.currentChallengeIds.includes(p.challenge_id),
  );

  // No leg satisfies this issuance (none matched it at all, or the one that did fails
  // validation - e.g. a bad signature) - the resource is never delivered, and nothing
  // behaves as though the route were paid, regardless of `route.behaviour`. Every leg
  // (including a valid-but-non-matching one, e.g. an attacker's) is still recorded
  // above and scored on its own merits.
  if (!matchingLeg?.valid) return { kind: "unmatched", payments };
  return { kind: "matched", payments, matchingLeg };
}
