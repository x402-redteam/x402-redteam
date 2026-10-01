/**
 * GDP-gated x402 header payments, per functional-design.md §2/§3 (`src/pay.ts`) and
 * ADR-010 §2 ("payment" then "sign", both must allow).
 *
 * Deviation from the file list's "signer wrapper -> GDP sign" (reported to the
 * architect): rather than wrapping the raw EVM/SVM signer to intercept the
 * cryptographic signing call itself, this builds the *complete, already-signed*
 * x402Client payload first (via the real `@x402/evm`/`@x402/svm` scheme clients, same
 * as the reference agents), decodes it with `@x402-redteam/capture` - the exact decoder
 * the harness later uses, so `decoded_legs` is never a hand-rolled preview - and only
 * then asks the GDP `sign` hook, attaching the payment header and sending the second
 * request iff it allows. In this no-real-funds harness, signing an EIP-3009
 * authorization or an SVM transaction has no side effect by itself (it is not a chain
 * submission); only attaching it to the paid HTTP retry can ever be observed by the
 * server/facilitator, so "deny before the header is ever sent" is exactly equivalent to
 * "deny before signing" - ADR-010's "any deny blocks the payment" holds either way.
 *
 * Spend controls are disabled entirely (`client.setSpendControls(false)`), not just the
 * per-payment cap: `@x402/core@2.28.0`
 * `node_modules/@x402/core/dist/esm/client/index.mjs:22` sets
 * `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"`, and `applySpendControls`
 * (same file, ~line 504) rejects any accept whose asset isn't in the scheme's own
 * default-asset table unless `allowedAssets` opts in - `setSpendControls(false)` is the
 * one call documented (`x402Client-C7_OogbK.d.mts:1900`) to disable both: "any asset, no
 * caps".
 */

import type { TransactionPartialSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { capture } from "@x402-redteam/capture";
import { amountUsd } from "@x402-redteam/schema";
import type { LocalAccount } from "viem";
import type { FetchLike } from "./crawl.js";
import type { GdpClient } from "./gdp.js";
import type {
  GdpHistoryEntry,
  GdpHook,
  GdpPaymentResponse,
  GdpSignPayload,
  GdpSignResponse,
} from "./protocol.js";

export interface PayWallet {
  chain: "evm" | "svm";
  evmAccount?: LocalAccount;
  svmSigner?: TransactionPartialSigner;
  solanaRpcUrl?: string;
}

export interface PayContext {
  gdp: GdpClient;
  hooks: Set<GdpHook>;
  history: GdpHistoryEntry[];
  wallet: PayWallet;
  log: (message: string) => void;
  /** Every 402 (url, raw body text) the driver has seen, appended to as encountered -
   * `main.ts` scans this alongside final page bodies for transfer intents, since a
   * successfully-paid 402 (e.g. challenge_injection) never shows up as a `CrawledPage`
   * with status 402 (functional-design.md §3 step 5). */
  challengeTexts: { url: string; text: string }[];
}

function evmChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`pay: unsupported evm network ${network}`);
  return Number(match[1]);
}

function buildClientForAccept(wallet: PayWallet, acceptIndex: number): x402Client {
  const client = new x402Client();
  client.setSpendControls(false);
  client.registerPolicy((_version, requirements) => {
    const chosen = requirements[acceptIndex];
    return chosen ? [chosen] : [];
  });
  if (wallet.chain === "evm") {
    if (!wallet.evmAccount) throw new Error("pay: missing evm account");
    registerExactEvmScheme(client, { signer: wallet.evmAccount });
  } else {
    if (!wallet.svmSigner) throw new Error("pay: missing svm signer");
    client.register(
      "solana:*" as Network,
      new ExactSvmScheme(wallet.svmSigner, { rpcUrl: wallet.solanaRpcUrl }),
    );
  }
  return client;
}

async function readBody(res: Response): Promise<{ text: string; parsed: unknown }> {
  const text = await res
    .clone()
    .text()
    .catch(() => "");
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { text, parsed };
}

async function signPreview(
  paymentPayload: Awaited<ReturnType<x402Client["createPaymentPayload"]>>,
  chain: "evm" | "svm",
): Promise<{ payload: GdpSignPayload; decoded_legs: unknown[] }> {
  const decoded = await capture.decodePayload(paymentPayload);
  const decoded_legs = decoded.legs ?? [decoded];
  if (chain === "evm") {
    const inner = paymentPayload.payload as {
      authorization?: Record<string, unknown>;
      signature?: string;
    };
    const accepted = paymentPayload.accepted;
    const typed_data = {
      domain: {
        name: (accepted.extra?.name as string | undefined) ?? "USDC",
        version: (accepted.extra?.version as string | undefined) ?? "2",
        chainId: evmChainId(accepted.network),
        verifyingContract: accepted.asset,
      },
      primaryType: "TransferWithAuthorization",
      message: inner.authorization,
    };
    return { payload: { typed_data }, decoded_legs };
  }
  const inner = paymentPayload.payload as { transaction?: string };
  return { payload: { serialized_tx: inner.transaction ?? "" }, decoded_legs };
}

export interface FetchWithGdpPaymentOptions {
  referrer: { url: string; text: string } | null;
  ctx: PayContext;
}

/**
 * Fetches `url` once. If the response is a 402, runs the GDP `payment` hook (when
 * implemented) to pick an accept and allow/deny, then - if allowed - builds and signs
 * the chosen payment, runs the GDP `sign` hook (when implemented), and either attaches
 * the payment header and refetches (returning that response) or leaves the original 402
 * response untouched (a deny at either hook). Never retries by itself - the driver's own
 * loop (main.ts) decides whether to retry the whole top-level fetch.
 */
export async function fetchWithGdpPayment(
  url: string,
  init: RequestInit | undefined,
  opts: FetchWithGdpPaymentOptions,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 402) return res;

  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return res;

  let paymentRequired: ReturnType<typeof decodePaymentRequiredHeader>;
  try {
    paymentRequired = decodePaymentRequiredHeader(header);
  } catch (err) {
    opts.ctx.log(`pay: failed to decode PAYMENT-REQUIRED header for ${url}: ${err}`);
    return res;
  }
  if (paymentRequired.accepts.length === 0) return res;

  const { text: rawText, parsed: rawBody } = await readBody(res);
  const { ctx } = opts;
  ctx.challengeTexts.push({ url, text: rawText });

  let acceptIndex = 0;
  if (ctx.hooks.has("payment")) {
    const decision = await ctx.gdp.request<GdpPaymentResponse>((id) => ({
      id,
      type: "payment",
      request: { url, method: init?.method ?? "GET" },
      referrer: opts.referrer,
      rail: "x402v2",
      challenge: {
        accepts: paymentRequired.accepts,
        resource: paymentRequired.resource,
        raw_body: rawBody,
      },
      history: ctx.history,
    }));
    if (decision.decision === "deny") {
      ctx.log(`payment denied for ${url}: ${decision.reason}`);
      return res;
    }
    if (
      !Number.isInteger(decision.accept_index) ||
      decision.accept_index < 0 ||
      decision.accept_index >= paymentRequired.accepts.length
    ) {
      ctx.log(`payment hook returned an out-of-range accept_index for ${url}; treating as deny`);
      return res;
    }
    acceptIndex = decision.accept_index;
  }

  const client = buildClientForAccept(ctx.wallet, acceptIndex);
  let paymentPayload: Awaited<ReturnType<x402Client["createPaymentPayload"]>>;
  try {
    paymentPayload = await client.createPaymentPayload(paymentRequired);
  } catch (err) {
    ctx.log(`pay: failed to build payment payload for ${url}: ${err}`);
    return res;
  }

  if (ctx.hooks.has("sign")) {
    const { payload, decoded_legs } = await signPreview(paymentPayload, ctx.wallet.chain);
    const decision = await ctx.gdp.request<GdpSignResponse>((id) => ({
      id,
      type: "sign",
      chain: ctx.wallet.chain,
      payload,
      decoded_legs,
    }));
    if (decision.decision === "deny") {
      ctx.log(`sign denied for ${url}: ${decision.reason}`);
      return res;
    }
  }

  const accepted = paymentPayload.accepted;
  ctx.history.push({
    url,
    amount_usd: amountUsd(ctx.wallet.chain, accepted.asset, accepted.amount),
    pay_to: accepted.payTo,
    network: accepted.network,
    asset: accepted.asset,
  });

  const paidHeaders = new Headers(init?.headers);
  paidHeaders.set("PAYMENT-SIGNATURE", encodePaymentSignatureHeader(paymentPayload));
  return fetch(url, { ...init, headers: paidHeaders });
}

/** Builds a `FetchLike` (for `crawl.ts`) that pays every 402 it meets, gated by GDP. */
export function buildPayFetch(
  ctx: PayContext,
  referrerOf: (url: string) => { url: string; text: string } | null,
): FetchLike {
  return (input, init) => fetchWithGdpPayment(input, init, { referrer: referrerOf(input), ctx });
}
