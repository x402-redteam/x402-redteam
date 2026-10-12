/**
 * v4 (U26-2, M2): sign intents. A page or 402 body that asks the wallet to sign
 * something that is not a payment (an EIP-7702 delegation, a raw digest, a message,
 * typed data) is a `sign_request`. The driver signs it locally (no side effect), decodes
 * the signature with `@x402-redteam/capture` exactly as the harness will, asks the GDP
 * `sign` hook, and POSTs the signature to the request's submit URL only on allow. A
 * guardrail without a `sign` hook is never asked, so the driver submits - it is a
 * maximally attempting payer.
 */
import { capture } from "@x402-redteam/capture";
import {
  parseSignRequest,
  type SignRequestWire,
  signRequestEvent,
  signRequestPayload,
  signSignRequest,
} from "@x402-redteam/schema";
import type { LocalAccount } from "viem";
import type { GdpClient } from "./gdp.js";
import type { GdpHook, GdpSignPayload, GdpSignResponse } from "./protocol.js";

export interface SignIntent {
  source: { url: string; text: string };
  request: SignRequestWire;
}

/**
 * Every distinct sign request in `sources` (page bodies and 402 bodies), in source
 * order. Two sources asking for the same signature at the same submit URL are one
 * intent (the crawler fetches every URL twice).
 */
export function extractSignIntents(sources: { url: string; text: string }[]): SignIntent[] {
  const seen = new Set<string>();
  const intents: SignIntent[] = [];
  for (const source of sources) {
    const request = parseSignRequest(source.text);
    if (!request) continue;
    const key = JSON.stringify(request);
    if (seen.has(key)) continue;
    seen.add(key);
    intents.push({ source, request });
  }
  return intents;
}

export interface SignIntentContext {
  // `evmAccount` must be a plain account that never reports to the harness ledger
  // (architect change 2): a signature is observed only when the driver POSTs it after an
  // allow. main.ts passes the bare `privateKeyToAccount` account; the driver never
  // shim-wraps it.
  gdp: GdpClient;
  hooks: Set<GdpHook>;
  evmAccount?: LocalAccount;
  /** Origins the driver may contact (`allowedOrigins(task)`); a submit URL anywhere else
   * is never contacted. */
  origins: Set<string>;
  log: (message: string) => void;
}

/** Handles one sign intent: sign, decode, ask the `sign` hook, submit on allow. Returns
 * true when the signature was submitted. */
export async function handleSignIntent(
  ctx: SignIntentContext,
  intent: SignIntent,
): Promise<boolean> {
  const account = ctx.evmAccount;
  if (!account) return false; // every sign request kind is an EVM signature.
  const { request } = intent;
  let origin: string;
  try {
    origin = new URL(request.submit_url).origin;
  } catch {
    return false;
  }
  if (!ctx.origins.has(origin)) {
    ctx.log(`sign request from ${intent.source.url} submits off the harness origins; skipped`);
    return false;
  }

  let signature: string;
  try {
    signature = await signSignRequest(account, request);
  } catch (err) {
    ctx.log(`sign request from ${intent.source.url} could not be signed: ${err}`);
    return false;
  }

  if (ctx.hooks.has("sign")) {
    let decoded: Awaited<ReturnType<typeof capture.decodeShimEvent>>;
    try {
      decoded = await capture.decodeShimEvent(
        signRequestEvent(request, signature, account.address),
      );
    } catch (err) {
      // Review L2: an undecodable request is skipped, never sent to the guardrail half-built.
      ctx.log(`sign request from ${intent.source.url} could not be decoded: ${err}`);
      return false;
    }
    const payload = signRequestPayload(request) as GdpSignPayload;
    const decision = await ctx.gdp.request<GdpSignResponse>((id) => ({
      id,
      type: "sign",
      chain: "evm",
      intent: "sign_request",
      payload,
      payloads: [payload],
      source: intent.source,
      decoded_legs: decoded.legs ?? [decoded],
    }));
    if (decision.decision !== "allow") {
      ctx.log(
        `sign request from ${intent.source.url} denied: ${"reason" in decision ? decision.reason : "denied"}`,
      );
      return false;
    }
  }

  try {
    const res = await fetch(request.submit_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature, address: account.address }),
    });
    await res.text().catch(() => "");
    return res.ok;
  } catch (err) {
    ctx.log(`sign request submit to ${request.submit_url} failed: ${err}`);
    return false;
  }
}
