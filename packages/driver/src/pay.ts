/**
 * GDP-gated x402 header payments, per functional-design.md §2/§3 (`src/pay.ts`) and
 * ADR-010 §2 ("payment" then "sign", both must allow).
 *
 * Code review round 1, finding 6: the signer *is* wrapped to capture the exact input the
 * SDK signs, rather than this file reconstructing a typed-data shape. v4 (U26-2, B2):
 * one payment can involve more than one signature (a Permit2 witness transfer plus an
 * EIP-2612 permit or a signed `approve` transaction from the SDK's gas-sponsoring
 * extensions), so every signing input is collected into a list, in signing order, and
 * the GDP `sign` request carries the whole list (`payloads`). `decoded_legs` is computed
 * from the complete, signed payload via `@x402-redteam/capture` - the decoder the
 * harness itself uses - and so includes the extension legs the run will be scored on.
 * Signing has no side effect by itself in this harness; only attaching the result to the
 * paid HTTP retry is observed, so a `sign` deny still guarantees nothing is sent.
 *
 * v4 (U26-2, B2): the EVM signer is `toClientEvmSigner(account, publicClient(evm_rpc_url))`,
 * the SDK's own composition for its extensions, so an approval the SDK would sign for a
 * real payer is signed (and judged by the guardrail) here too.
 *
 * Spend controls are disabled entirely (`client.setSpendControls(false)`), not just the
 * per-payment cap: `@x402/core@2.28.0` sets `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"` and
 * rejects any accept whose asset isn't in the scheme's default-asset table unless
 * `allowedAssets` opts in; `setSpendControls(false)` disables both.
 *
 * v4 (U26-2, B4): `buildDeferringFetch` and `payDeferred` split one payment into its
 * phases for `task.parallel`: every 402 is fetched first, then every GDP `payment`
 * request is sent before any answer is awaited, then the allowed ones are signed and
 * paid one at a time, all in canonical URL order.
 */

import {
  getBase64EncodedWireTransaction,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { capture } from "@x402-redteam/capture";
import { amountUsd, compareCodeUnits } from "@x402-redteam/schema";
import { createPublicClient, http, type LocalAccount } from "viem";
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
  /** v4 (U26-2): the mock EVM RPC the SDK's extension reads (`allowance`, `nonces`,
   * nonce and fee lookups) go to. */
  evmRpcUrl?: string;
}

export interface PayContext {
  gdp: GdpClient;
  hooks: Set<GdpHook>;
  history: GdpHistoryEntry[];
  wallet: PayWallet;
  log: (message: string) => void;
  /** Every 402 (url, raw body text) the driver has seen, appended to as encountered -
   * `main.ts` scans this alongside final page bodies for transfer and sign intents,
   * since a successfully-paid 402 (e.g. challenge_injection) never shows up as a
   * `CrawledPage` with status 402 (functional-design.md §3 step 5). */
  challengeTexts: { url: string; text: string }[];
}

function evmChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`pay: unsupported evm network ${network}`);
  return Number(match[1]);
}

/**
 * Builds a fresh `x402Client` for one specific accept (`target`), scoped to this
 * wallet's chain, with spend controls fully disabled and the signer wrapped so that
 * every signing input is appended to `captured` (in signing order).
 *
 * Code review finding 3 (BLOCK): selects `target` by *object identity*, not by
 * re-indexing - `x402Client`'s `selectPaymentRequirements` filters `accepts` before any
 * policy runs, so `requirements[acceptIndex]` on that filtered array could pay a
 * different accept than the guardrail named. When `target` isn't in the filtered list,
 * the policy returns `[]`, which `createPaymentPayload` turns into a thrown error the
 * caller logs as "unpayable".
 */
function buildClientForAccept(
  wallet: PayWallet,
  target: PaymentRequirements,
  captured: GdpSignPayload[],
): x402Client {
  const client = new x402Client();
  client.setSpendControls(false);
  client.registerPolicy((_version, requirements) =>
    requirements.includes(target) ? [target] : [],
  );
  if (wallet.chain === "evm") {
    const account = wallet.evmAccount;
    if (!account) throw new Error("pay: missing evm account");
    const wrapped: LocalAccount = {
      ...account,
      async signTypedData(parameters) {
        captured.push({
          typed_data: {
            domain: parameters.domain,
            types: parameters.types,
            primaryType: parameters.primaryType as string,
            message: parameters.message,
          },
        });
        return account.signTypedData(parameters);
      },
      async signTransaction(transaction, options) {
        const signed = await account.signTransaction(transaction, options);
        captured.push({ serialized_tx: signed });
        return signed;
      },
    };
    const publicClient = wallet.evmRpcUrl
      ? createPublicClient({ transport: http(wallet.evmRpcUrl) })
      : undefined;
    registerExactEvmScheme(client, { signer: toClientEvmSigner(wrapped, publicClient) });
  } else {
    const signer = wallet.svmSigner;
    if (!signer) throw new Error("pay: missing svm signer");
    const wrapped: TransactionPartialSigner = {
      address: signer.address,
      async signTransactions(transactions, config) {
        const unsigned = transactions[0];
        if (unsigned) {
          try {
            captured.push({
              serialized_tx: getBase64EncodedWireTransaction(unsigned as Transaction),
            });
          } catch {
            // Best-effort preview only - `buildSignPayloads` falls back to the final,
            // fully-signed payload's wire transaction if this couldn't be encoded
            // pre-signature on some kit transaction shape.
          }
        }
        return signer.signTransactions(transactions, config);
      },
    };
    client.register(
      "solana:*" as Network,
      new ExactSvmScheme(wrapped, { rpcUrl: wallet.solanaRpcUrl }),
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

/**
 * The GDP `sign` payloads for the payment just built: every signing input the wrapped
 * signer captured, in order, else a best-effort reconstruction from the final signed
 * payload. `decoded_legs` is always computed from the complete, signed `paymentPayload`
 * (payment leg first, then any extension legs).
 */
async function buildSignPayloads(
  paymentPayload: PaymentPayload,
  chain: "evm" | "svm",
  captured: GdpSignPayload[],
): Promise<{ payloads: GdpSignPayload[]; decoded_legs: unknown[] }> {
  const decoded = await capture.decodePayload(paymentPayload);
  const decoded_legs = decoded.legs ?? [decoded];
  if (captured.length > 0) {
    return { payloads: captured, decoded_legs };
  }
  if (chain === "evm") {
    const inner = paymentPayload.payload as { authorization?: Record<string, unknown> };
    const accepted = paymentPayload.accepted;
    return {
      payloads: [
        {
          typed_data: {
            domain: {
              name: (accepted.extra?.name as string | undefined) ?? "USDC",
              version: (accepted.extra?.version as string | undefined) ?? "2",
              chainId: evmChainId(accepted.network),
              verifyingContract: accepted.asset,
            },
            primaryType: "TransferWithAuthorization",
            message: inner.authorization,
          },
        },
      ],
      decoded_legs,
    };
  }
  const inner = paymentPayload.payload as { transaction?: string };
  return { payloads: [{ serialized_tx: inner.transaction ?? "" }], decoded_legs };
}

/** A 402 the driver read and has not paid yet. */
export interface PendingChallenge {
  url: string;
  init: RequestInit | undefined;
  /** The unpaid 402 response, returned as-is when the payment is denied or unpayable. */
  res: Response;
  paymentRequired: PaymentRequired;
  rawBody: unknown;
  referrer: { url: string; text: string } | null;
}

/** Fetches `url` once and, when the answer is a payable 402, returns it as a pending
 * challenge (and records its body in `challengeTexts`). */
async function fetchChallenge(
  url: string,
  init: RequestInit | undefined,
  referrer: { url: string; text: string } | null,
  ctx: PayContext,
): Promise<{ res: Response; pending?: PendingChallenge }> {
  const res = await fetch(url, init);
  if (res.status !== 402) return { res };

  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return { res };

  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(header);
  } catch (err) {
    ctx.log(`pay: failed to decode PAYMENT-REQUIRED header for ${url}: ${err}`);
    return { res };
  }
  if (paymentRequired.accepts.length === 0) return { res };

  const { text: rawText, parsed: rawBody } = await readBody(res);
  ctx.challengeTexts.push({ url, text: rawText });
  return { res, pending: { url, init, res, paymentRequired, rawBody, referrer } };
}

/**
 * Sends the GDP `payment` request for `pending` and returns the pending answer, or
 * `undefined` when the guardrail has no `payment` hook (the first accept is then paid).
 * The request is written to the guardrail before this returns; `history` is what was
 * signed before that moment.
 */
function requestPaymentDecision(
  pending: PendingChallenge,
  ctx: PayContext,
): Promise<GdpPaymentResponse> | undefined {
  if (!ctx.hooks.has("payment")) return undefined;
  return ctx.gdp.request<GdpPaymentResponse>((id) => ({
    id,
    type: "payment",
    request: { url: pending.url, method: pending.init?.method ?? "GET" },
    referrer: pending.referrer,
    rail: "x402v2",
    challenge: {
      accepts: pending.paymentRequired.accepts,
      resource: pending.paymentRequired.resource,
      raw_body: pending.rawBody,
    },
    history: ctx.history,
  }));
}

/**
 * Builds, signs (behind the GDP `sign` hook) and sends the payment for `pending`, given
 * the `payment` hook's answer. Returns the paid response, or the original 402 on any deny
 * or when the SDK can't pay the chosen accept.
 */
async function completePayment(
  pending: PendingChallenge,
  decision: GdpPaymentResponse | undefined,
  ctx: PayContext,
): Promise<Response> {
  const { url, init, res, paymentRequired } = pending;
  let acceptIndex = 0;
  if (decision !== undefined) {
    // GdpClient already normalizes a malformed/mismatched/timed-out response to a clean
    // `{decision:"deny"}`, so the only way past this point is a literal "allow".
    if (decision.decision !== "allow") {
      ctx.log(`payment denied for ${url}: ${"reason" in decision ? decision.reason : "denied"}`);
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

  const target = paymentRequired.accepts[acceptIndex];
  if (!target) {
    ctx.log(`payment: accept_index ${acceptIndex} for ${url} does not exist; treating as deny`);
    return res;
  }

  const captured: GdpSignPayload[] = [];
  const client = buildClientForAccept(ctx.wallet, target, captured);
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = await client.createPaymentPayload(paymentRequired);
  } catch (err) {
    // Finding 3: an accept the guardrail chose but the SDK can't service lands here -
    // logged as unpayable, never silently paid as a different accept.
    ctx.log(`payment: accept_index ${acceptIndex} for ${url} is unpayable by this wallet: ${err}`);
    return res;
  }

  if (ctx.hooks.has("sign")) {
    const { payloads, decoded_legs } = await buildSignPayloads(
      paymentPayload,
      ctx.wallet.chain,
      captured,
    );
    const decision = await ctx.gdp.request<GdpSignResponse>((id) => ({
      id,
      type: "sign",
      chain: ctx.wallet.chain,
      intent: "payment",
      payload: payloads[0] as GdpSignPayload,
      payloads,
      decoded_legs,
    }));
    if (decision.decision !== "allow") {
      ctx.log(`sign denied for ${url}: ${"reason" in decision ? decision.reason : "denied"}`);
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

export interface FetchWithGdpPaymentOptions {
  referrer: { url: string; text: string } | null;
  ctx: PayContext;
}

/**
 * Fetches `url` once. If the response is a 402, runs the GDP `payment` hook (when
 * implemented) to pick an accept and allow/deny, then - if allowed - builds and signs
 * the chosen payment, runs the GDP `sign` hook (when implemented), and either attaches
 * the payment header and refetches (returning that response) or leaves the original 402
 * response untouched. Never retries by itself - the driver's own loop (main.ts) decides
 * whether to retry the whole top-level fetch.
 */
export async function fetchWithGdpPayment(
  url: string,
  init: RequestInit | undefined,
  opts: FetchWithGdpPaymentOptions,
): Promise<Response> {
  const { res, pending } = await fetchChallenge(url, init, opts.referrer, opts.ctx);
  if (!pending) return res;
  return completePayment(pending, await requestPaymentDecision(pending, opts.ctx), opts.ctx);
}

/** Builds a `FetchLike` (for `crawl.ts`) that pays every 402 it meets, gated by GDP. */
export function buildPayFetch(
  ctx: PayContext,
  referrerOf: (url: string) => { url: string; text: string } | null,
): FetchLike {
  return (input, init) => fetchWithGdpPayment(input, init, { referrer: referrerOf(input), ctx });
}

/**
 * v4 (U26-2, B4): a `FetchLike` that pays nothing. Every payable 402 it meets is kept in
 * `deferred` (the latest one per URL) and returned unpaid, for `payDeferred` to pay after
 * the crawl.
 */
export function buildDeferringFetch(
  ctx: PayContext,
  referrerOf: (url: string) => { url: string; text: string } | null,
  deferred: Map<string, PendingChallenge>,
): FetchLike {
  return async (input, init) => {
    const { res, pending } = await fetchChallenge(input, init, referrerOf(input), ctx);
    if (pending) deferred.set(input, pending);
    return res;
  };
}

/**
 * v4 (U26-2, B4, condition 5): pays every deferred 402 the way a concurrent agent would
 * meet them. All the GDP `payment` requests are sent in canonical URL order before any
 * answer is awaited, so the guardrail sees them overlap and each request's `history`
 * holds only what was signed before it was sent. The allowed ones are then signed and
 * paid one at a time, in the same canonical order, so the ledger's `seq` order never
 * depends on response timing. Returns the paid pages.
 */
export async function payDeferred(
  ctx: PayContext,
  deferred: Map<string, PendingChallenge>,
): Promise<{ url: string; status: number; body: string }[]> {
  const ordered = [...deferred.values()].sort((a, b) => compareCodeUnits(a.url, b.url));
  const decisions = ordered.map((pending) => requestPaymentDecision(pending, ctx));
  const pages: { url: string; status: number; body: string }[] = [];
  for (const [i, pending] of ordered.entries()) {
    const res = await completePayment(pending, await decisions[i], ctx);
    if (res === pending.res) continue;
    pages.push({ url: pending.url, status: res.status, body: await res.text().catch(() => "") });
  }
  return pages;
}
