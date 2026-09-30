import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { Network, PaymentPayload, SettleResponse } from "@x402/core/types";
import { atomicToUsd, type Payment, type RequestLog } from "@x402-redteam/schema";
import type { Context, Hono } from "hono";
import { buildPaymentRequired, buildRequirements } from "./challenge.js";
import { fakeTransactionHash } from "./fake-hash.js";
import { findRoute, type RenderedRoute, type RenderedScenario } from "./render.js";
import type { Shared } from "./shared.js";
import type { RunState } from "./state.js";

const AMOUNT_DECIMALS = 6;
const HOST_PREFIX = "/_host/";
const DEFAULT_HOST = "provider.test";

function resolveHostPath(pathname: string): { host: string; path: string } {
  if (pathname.startsWith(HOST_PREFIX)) {
    const rest = pathname.slice(HOST_PREFIX.length);
    const slash = rest.indexOf("/");
    return slash === -1
      ? { host: rest, path: "" }
      : { host: rest.slice(0, slash), path: rest.slice(slash) };
  }
  return { host: DEFAULT_HOST, path: pathname };
}

function logRequest(state: RunState, entry: Omit<RequestLog, "seq">): void {
  state.requests.push({ ...entry, seq: state.nextSeq() });
}

/** Every scenario route, at `/_host/:host/<rest>` and the default host, per functional-design.md §3. */
export function registerScenarioRoutes(app: Hono, shared: Shared): void {
  app.all("*", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state, rendered } = loaded;

    const url = new URL(c.req.url);
    const { host, path } = resolveHostPath(url.pathname);
    const method = c.req.method;

    const route = findRoute(rendered, method, host, path);
    if (!route) {
      logRequest(state, { method, host, path, status: 404, paid: false });
      return c.body("not found", 404);
    }

    if (!route.challenge) {
      return serveFree(c, state, route, method, host, path);
    }

    return serveChallenge(c, shared, state, rendered, route, method, host, path, url.toString());
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
    const requirements = buildRequirements(route, state.chain, shared.seed);
    const paymentRequired = buildPaymentRequired(absoluteUrl, route, requirements);
    runtime.challengeCounter += 1;
    const challenge_id = `${route.route_key}#${runtime.challengeCounter}`;
    state.challenges.push({
      challenge_id,
      route_key: route.route_key,
      requirements,
      // v2 (accepts_ordering, application-design.md §4 "v2"): every entry that went on
      // the wire, in order. Part A only threads the type through; a route still ever
      // issues a single-option challenge until U11 wires up ChallengeSpec.accepts here.
      accepts: [requirements],
      seq: state.nextSeq(),
    });
    c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
    logRequest(state, { method, host, path, status: 402, paid });
    return c.json({ x402Version: 2, error: "payment_required", accepts: [requirements] }, 402);
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

  const attribution = shared.capture.attribute(decoded, {
    challenges: state.challenges,
    pageBodies: state.pageBodies,
    prior: state.payments,
  });
  const seq = state.nextSeq();
  const payment: Payment = {
    payment_id: `p${seq}`,
    seq,
    capture: "header",
    chain: state.chain,
    network: decoded.network,
    scheme: decoded.scheme,
    asset: decoded.asset,
    from: decoded.from,
    to: decoded.to,
    amount_atomic: decoded.amount_atomic,
    amount_usd: atomicToUsd(decoded.amount_atomic, AMOUNT_DECIMALS),
    route_key: route.route_key,
    host,
    dedupe_key: decoded.dedupe_key,
    instruction_source: attribution.instruction_source,
    challenge_id: attribution.challenge_id,
    replay: attribution.replay,
    valid: decoded.valid,
    raw: decoded.raw,
  };
  state.payments = shared.capture.merge(state.payments, payment);

  const deliver = (): Response => {
    runtime.deliveredOnce = true;
    state.delivered = true;
    const body = route.delivered_body ?? route.page ?? "ok";
    state.pageBodies.push(body);
    const txHash = fakeTransactionHash(state.chain, state.run_id, payment.seq);
    const settleResponse: SettleResponse = {
      success: true,
      transaction: txHash,
      network: decoded.network as Network,
      payer: decoded.from,
    };
    c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    logRequest(state, { method, host, path, status: 200, paid: true });
    return c.body(body, 200, { "content-type": route.content_type });
  };

  const noDelivery = (): Response => {
    const settleResponse: SettleResponse = {
      success: true,
      transaction: fakeTransactionHash(state.chain, state.run_id, payment.seq),
      network: decoded.network as Network,
      payer: decoded.from,
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
