import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { Network, PaymentPayload, SettleResponse } from "@x402/core/types";
import type { RequestLog } from "@x402-redteam/schema";
import type { Context, Hono } from "hono";
import { buildPaymentRequired, buildRequirementsList } from "./challenge.js";
import { fakeTransactionHash } from "./fake-hash.js";
import { resolveHost } from "./hosts.js";
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

    return serveChallenge(c, shared, state, rendered, route, method, host, path, c.req.url);
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
  absoluteUrl: string,
): Promise<Response> {
  const runtime = state.runtimeFor(route.route_key);

  const issueChallenge = (paid: boolean): Response => {
    const requirementsList = buildRequirementsList(
      route,
      state.chain,
      shared.seed,
      state.scenario.assets,
    );
    const paymentRequired = buildPaymentRequired(absoluteUrl, route, requirementsList);
    runtime.challengeCounter += 1;
    const challenge_id = `${route.route_key}#${runtime.challengeCounter}`;
    state.challenges.push({
      challenge_id,
      route_key: route.route_key,
      // Kept for v1 readers; the first entry, per application-design.md §4 "v2".
      requirements: requirementsList[0] as (typeof requirementsList)[number],
      // v2 (accepts_ordering, application-design.md §4 "v2"): every entry that went on
      // the wire, in order.
      accepts: requirementsList,
      seq: state.nextSeq(),
    });
    c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
    logRequest(state, { method, host, path, status: 402, paid });
    // v2 (challenge_injection): a scenario-supplied body_json replaces the default 402
    // body wholesale and, like any other page-visible text, is searched by prose
    // attribution (application-design.md §4 "v2" - the adversary pushes it into pageBodies).
    const bodyJson =
      route.challenge?.body_json ??
      ({ x402Version: 2, error: "payment_required", accepts: requirementsList } as const);
    if (route.challenge?.body_json !== undefined) {
      state.pageBodies.push(JSON.stringify(bodyJson));
    }
    return c.json(bodyJson, 402);
  };

  const headerValue = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT");
  if (!headerValue) {
    return issueChallenge(false);
  }

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(headerValue);
  } catch {
    logRequest(state, { method, host, path, status: 400, paid: false });
    return c.json({ error: "invalid_payment" }, 400);
  }

  let decoded: Awaited<ReturnType<Shared["capture"]["decodePayload"]>>;
  try {
    decoded = await shared.capture.decodePayload(payload, { knownOwners: rendered.knownOwners });
  } catch {
    logRequest(state, { method, host, path, status: 400, paid: false });
    return c.json({ error: "invalid_payment" }, 400);
  }

  // Coordinator addition (H1 parity with the rpc path in solana-rpc.ts): a single
  // header submission can carry more than one value-moving leg (e.g. an SVM
  // transaction with two TransferChecked instructions - one matching this route's
  // challenge, one paying an attacker) - record every leg as its own Payment, not just
  // the primary one, so a hidden second leg is still scored.
  const payments = recordDecodedLegs(state, shared.capture, decoded, {
    capture: "header",
    host,
    route_key: route.route_key,
  });

  // The challenge this route most recently issued (the one this request is presumably
  // paying for) - `runtime.challengeCounter` already reflects the last `issueChallenge`
  // call for this route_key, since it isn't bumped again until the next one.
  const currentChallengeId = `${route.route_key}#${runtime.challengeCounter}`;
  // Delivery depends specifically on the leg that satisfies *this* challenge, not
  // merely on whether the submission decoded validly - a submission can be a validly
  // signed, on-chain-valid transaction that also happens to bundle in an unrelated
  // (e.g. attacker-directed) leg alongside the legitimate one.
  const matchingLeg = payments.find((p) => p.challenge_id === currentChallengeId);

  // No leg satisfies this specific challenge (none matched it at all, or the one that
  // did fails validation - e.g. a bad signature) - the resource is never delivered,
  // and nothing behaves as though the route were paid, regardless of `route.behaviour`.
  // Every leg (including a valid-but-non-matching one, e.g. an attacker's) is still
  // recorded above and scored on its own merits.
  if (!matchingLeg?.valid) {
    const fallback = payments[0];
    const settleResponse: SettleResponse = {
      success: false,
      errorReason: "invalid_payment",
      transaction: "",
      network: (fallback?.network ?? decoded.network) as Network,
      payer: fallback?.from ?? decoded.from,
    };
    c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    logRequest(state, { method, host, path, status: 402, paid: false });
    return c.json({ error: "invalid_payment" }, 402);
  }

  const deliver = (): Response => {
    runtime.deliveredOnce = true;
    state.delivered = true;
    const body = route.delivered_body ?? route.page ?? "ok";
    state.pageBodies.push(body);
    const txHash = fakeTransactionHash(state.chain, state.run_id, matchingLeg.seq);
    const settleResponse: SettleResponse = {
      success: true,
      transaction: txHash,
      network: matchingLeg.network as Network,
      payer: matchingLeg.from,
    };
    c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    logRequest(state, { method, host, path, status: 200, paid: true });
    return c.body(body, 200, { "content-type": route.content_type });
  };

  const noDelivery = (): Response => {
    const settleResponse: SettleResponse = {
      success: true,
      transaction: fakeTransactionHash(state.chain, state.run_id, matchingLeg.seq),
      network: matchingLeg.network as Network,
      payer: matchingLeg.from,
    };
    c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
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
