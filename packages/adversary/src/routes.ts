import type { RequestLog } from "@x402-redteam/schema";
import type { Context, Hono } from "hono";
import { fakeTransactionHash } from "./fake-hash.js";
import { resolveHost } from "./hosts.js";
import { knownTokenAccountsFor } from "./known-token-accounts.js";
import { railFor } from "./rails/index.js";
import type { Rail } from "./rails/rail.js";
import { recordDecodedLegs } from "./record.js";
import { findRoute, type RenderedRoute, type RenderedScenario } from "./render.js";
import type { Shared } from "./shared.js";
import type { RunState } from "./state.js";

function logRequest(state: RunState, entry: Omit<RequestLog, "seq">): void {
  state.requests.push({ ...entry, seq: state.nextSeq() });
}

/** Every scenario route, at `/_host/:host/<rest>` and the default host, per functional-design.md §3. */
export function registerScenarioRoutes(app: Hono, shared: Shared): void {
  app.all("*", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state, rendered } = loaded;

    const { host, path } = resolveHost(c, rendered.host_mode);
    const method = c.req.method;

    const route = findRoute(rendered, method, host, path);
    if (!route) {
      logRequest(state, { method, host, path, status: 404, paid: false });
      return c.body("not found", 404);
    }

    if (!route.challenge) {
      return serveFree(c, state, route, method, host, path);
    }

    // U20 code review fix 5: `adversary/index.ts`'s `load()` already resolved this
    // scenario's rail (throwing `NotImplementedRail` there if unsupported). A
    // `RunState` built directly rather than through `load()` (tests) falls back to
    // resolving it here, lazily.
    const rail = state.rail ?? railFor(state.scenario.rail, state.scenario.id);
    return serveChallenge(c, shared, state, rendered, route, method, host, path, rail);
  });
}

function serveFree(
  c: Context,
  state: RunState,
  route: RenderedRoute,
  method: string,
  host: string,
  path: string,
): Response | Promise<Response> {
  if (route.redirect !== undefined) {
    logRequest(state, { method, host, path, status: 302, paid: false });
    c.header("Location", route.redirect);
    return c.body(null, 302);
  }
  const body = route.page ?? "ok";
  state.pageBodies.push(body);
  logRequest(state, { method, host, path, status: 200, paid: false });
  return c.body(body, 200, { "content-type": route.content_type });
}

async function serveChallenge(
  c: Context,
  shared: Shared,
  state: RunState,
  rendered: RenderedScenario,
  route: RenderedRoute,
  method: string,
  host: string,
  path: string,
  rail: Rail,
): Promise<Response> {
  const runtime = state.runtimeFor(route.route_key);

  const issueChallenge = (paid: boolean): Response => {
    runtime.challengeCounter += 1;
    const challenge_id = `${route.route_key}#${runtime.challengeCounter}`;
    const result = rail.issue({
      route,
      chain: state.chain,
      seed: shared.seed,
      scenarioAssets: state.scenario.assets,
      url: c.req.url,
      challenge_id,
      seq: state.nextSeq(),
    });
    for (const issued of result.issued) state.challenges.push(issued);
    // U20 code review fix 7: every id from THIS issuance - x402v2 always has one, MPP
    // may have several - so a credential answering any of them can deliver.
    runtime.currentChallengeIds = result.issued.map((issued) => issued.challenge_id);
    for (const [name, value] of Object.entries(result.headers)) c.header(name, value);
    logRequest(state, { method, host, path, status: 402, paid });
    // v2 (challenge_injection): a scenario-supplied body_json replaces the default 402
    // body wholesale and, like any other page-visible text, is searched by prose
    // attribution (application-design.md §4 "v2" - the adversary pushes it into pageBodies).
    if (route.challenge?.body_json !== undefined) {
      state.pageBodies.push(JSON.stringify(result.body));
    }
    return c.json(result.body, 402);
  };

  const rawCredential = rail.extract(c.req.raw);
  if (!rawCredential) {
    return issueChallenge(false);
  }

  let bindingMismatch: boolean;
  let payments: ReturnType<typeof recordDecodedLegs>;
  try {
    const result = await rail.decode(rawCredential, {
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
      url: c.req.url,
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
    // `recordDecodedLegs` already flattens one level of nesting per top-level entry
    // (H1); flatMap here handles a rail that itself returns more than one top-level
    // entry (x402v2 never does; a future push-mode/multi-credential rail might).
    payments = result.legs.flatMap((leg) =>
      recordDecodedLegs(state, shared.capture, leg, {
        capture: "header",
        host,
        route_key: route.route_key,
        bindingMismatch,
      }),
    );
  } catch {
    logRequest(state, { method, host, path, status: 400, paid: false });
    return c.json({ error: "invalid_payment" }, 400);
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
  if (!matchingLeg?.valid) {
    const fallback = payments[0] as (typeof payments)[number];
    const headers = rail.settle({
      success: false,
      errorReason: "invalid_payment",
      transaction: "",
      network: fallback.network,
      payer: fallback.from,
    });
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    logRequest(state, { method, host, path, status: 402, paid: false });
    return c.json({ error: "invalid_payment" }, 402);
  }

  const deliver = (): Response => {
    runtime.deliveredOnce = true;
    state.delivered = true;
    const body = route.delivered_body ?? route.page ?? "ok";
    state.pageBodies.push(body);
    const txHash = fakeTransactionHash(state.chain, state.run_id, matchingLeg.seq);
    const headers = rail.settle({
      success: true,
      transaction: txHash,
      network: matchingLeg.network,
      payer: matchingLeg.from,
    });
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    logRequest(state, { method, host, path, status: 200, paid: true });
    return c.body(body, 200, { "content-type": route.content_type });
  };

  const noDelivery = (): Response => {
    const headers = rail.settle({
      success: true,
      transaction: fakeTransactionHash(state.chain, state.run_id, matchingLeg.seq),
      network: matchingLeg.network,
      payer: matchingLeg.from,
    });
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    logRequest(state, { method, host, path, status: 200, paid: true });
    return c.body("", 200, { "content-type": route.content_type });
  };

  switch (route.behaviour) {
    case "normal":
      return deliver();
    case "no_delivery":
      return noDelivery();
    case "402_forever":
      return issueChallenge(true);
    case "replay":
      return runtime.deliveredOnce ? issueChallenge(true) : deliver();
    default:
      return deliver();
  }
}
