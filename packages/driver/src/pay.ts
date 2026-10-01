/**
 * GDP-gated x402 header payments, per functional-design.md §2/§3 (`src/pay.ts`) and
 * ADR-010 §2 ("payment" then "sign", both must allow).
 *
 * Code review round 1, finding 6: the signer *is* wrapped (per the file list's "signer
 * wrapper -> GDP sign") to capture the exact `signTypedData` input (domain, types,
 * primaryType, message) the SDK actually signs - this covers Permit2 as well as
 * EIP-3009, whatever `@x402/evm`'s scheme client decides to use for a given accept,
 * rather than this file guessing/reconstructing a typed-data shape (the earlier
 * reconstruction only understood EIP-3009's `authorization` field and silently produced
 * a broken preview for anything else). The real signature is still produced by calling
 * through to the wrapped account/signer (signing an EIP-3009 authorization or an SVM
 * transaction has no side effect by itself in this no-real-funds harness - only
 * attaching the result to the paid HTTP retry is ever observed by the
 * server/facilitator), and `decoded_legs` is still computed post-hoc from the complete,
 * signed payload via `@x402-redteam/capture` - the exact decoder the harness later uses,
 * never a hand-rolled preview. A `sign` deny still guarantees the header is never
 * attached/sent, so ADR-010's "any deny blocks the payment" holds either way.
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

import {
  getBase64EncodedWireTransaction,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
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

/** Mutable box the wrapped signer below fills in with the exact input it was asked to
 * sign, so the caller (after `createPaymentPayload` returns) can hand it to the GDP
 * `sign` hook verbatim instead of reconstructing it. */
interface CapturedSignInput {
  value?: GdpSignPayload;
}

function evmChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`pay: unsupported evm network ${network}`);
  return Number(match[1]);
}

/**
 * Builds a fresh `x402Client` for one specific accept (`target`), scoped to this
 * wallet's chain, with spend controls fully disabled and the signer wrapped to capture
 * its exact signing input into `captured` (code review finding 6).
 *
 * Code review finding 3 (BLOCK): selects `target` by *object identity*, not by
 * re-indexing. `x402Client`'s own `selectPaymentRequirements`
 * (`node_modules/@x402/core/dist/esm/client/index.mjs`, ~line 442) filters
 * `paymentRequired.accepts` down to the entries a registered scheme/network actually
 * supports *before* any policy runs, so the array a policy receives is not guaranteed to
 * be `paymentRequired.accepts` in its original order or even the same length - selecting
 * `requirements[acceptIndex]` on that filtered array could silently pay a *different*
 * accept than the guardrail's `accept_index` actually named (the kind of bug that
 * produces a valid-looking but wrong report). `target` is `paymentRequired.accepts[i]`
 * itself (a specific object reference), so `requirements.includes(target)` is correct
 * regardless of what got filtered or reordered upstream - and when `target` isn't in the
 * filtered list at all, the policy returns `[]`, which `createPaymentPayload` turns into
 * a thrown error the caller logs as "unpayable" rather than silently paying something
 * else.
 */
function buildClientForAccept(
  wallet: PayWallet,
  target: PaymentRequirements,
  captured: CapturedSignInput,
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
        captured.value = {
          typed_data: {
            domain: parameters.domain,
            types: parameters.types,
            primaryType: parameters.primaryType as string,
            message: parameters.message,
          },
        };
        return account.signTypedData(parameters);
      },
    };
    registerExactEvmScheme(client, { signer: wrapped });
  } else {
    const signer = wallet.svmSigner;
    if (!signer) throw new Error("pay: missing svm signer");
    const wrapped: TransactionPartialSigner = {
      address: signer.address,
      async signTransactions(transactions, config) {
        const unsigned = transactions[0];
        if (unsigned) {
          try {
            captured.value = {
              serialized_tx: getBase64EncodedWireTransaction(unsigned as Transaction),
            };
          } catch {
            // Best-effort preview only - `buildSignPayload` falls back to the final,
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
 * The GDP `sign` payload for the payment just built: the wrapped signer's captured exact
 * input when available (finding 6), else a best-effort reconstruction from the final
 * signed payload (should only happen if the capture above couldn't run, e.g. a scheme
 * that signs more than one thing and only the first was captured). `decoded_legs` is
 * always computed post-hoc from the complete, signed `paymentPayload` via
 * `@x402-redteam/capture`.
 */
async function buildSignPayload(
  paymentPayload: PaymentPayload,
  chain: "evm" | "svm",
  captured: CapturedSignInput,
): Promise<{ payload: GdpSignPayload; decoded_legs: unknown[] }> {
  const decoded = await capture.decodePayload(paymentPayload);
  const decoded_legs = decoded.legs ?? [decoded];
  if (captured.value) {
    return { payload: captured.value, decoded_legs };
  }
  if (chain === "evm") {
    const inner = paymentPayload.payload as { authorization?: Record<string, unknown> };
    const accepted = paymentPayload.accepted;
    return {
      payload: {
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
      decoded_legs,
    };
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
 * response untouched (a deny at either hook, or an accept the SDK can't actually pay).
 * Never retries by itself - the driver's own loop (main.ts) decides whether to retry the
 * whole top-level fetch.
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

  const captured: CapturedSignInput = {};
  const client = buildClientForAccept(ctx.wallet, target, captured);
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = await client.createPaymentPayload(paymentRequired);
  } catch (err) {
    // Finding 3: this is also where an accept the guardrail chose but the SDK can't
    // actually service (filtered by network/scheme/spend controls upstream of our
    // identity-based policy) lands - logged as unpayable, never silently paid as a
    // different accept.
    ctx.log(`payment: accept_index ${acceptIndex} for ${url} is unpayable by this wallet: ${err}`);
    return res;
  }

  if (ctx.hooks.has("sign")) {
    const { payload, decoded_legs } = await buildSignPayload(
      paymentPayload,
      ctx.wallet.chain,
      captured,
    );
    const decision = await ctx.gdp.request<GdpSignResponse>((id) => ({
      id,
      type: "sign",
      chain: ctx.wallet.chain,
      payload,
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

/** Builds a `FetchLike` (for `crawl.ts`) that pays every 402 it meets, gated by GDP. */
export function buildPayFetch(
  ctx: PayContext,
  referrerOf: (url: string) => { url: string; text: string } | null,
): FetchLike {
  return (input, init) => fetchWithGdpPayment(input, init, { referrer: referrerOf(input), ctx });
}
