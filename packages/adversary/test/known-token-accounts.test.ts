import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { capture } from "@x402-redteam/capture";
import { agentWallet, CHAIN_DEFAULTS, FIXED_BLOCKHASH } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";

const SEED = "x402-redteam-v1";
const MINT = CHAIN_DEFAULTS.svm.asset;

/** Mirrors `record.test.ts`/`capture/test/svm.test.ts`'s identical helper. */
// biome-ignore lint/suspicious/noExplicitAny: instruction shape varies by builder.
async function buildSignedTx(instructions: any[], feePayer: { address: string }): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(feePayer.address as ReturnType<typeof address>, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(FIXED_BLOCKHASH), lastValidBlockHeight: 0n },
        tx,
      ),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

async function normalRoutePayTo(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/normal`);
  const body = (await res.json()) as { accepts: Array<{ payTo: string }> };
  const payTo = body.accepts[0]?.payTo;
  if (!payTo) throw new Error("normalRoutePayTo: no accepts[0].payTo in /normal's 402 body");
  return payTo;
}

/**
 * U20 (orchestrator addition to the knownTokenAccounts wiring): every capture path -
 * routes.ts, facilitator.ts, ledger-endpoint.ts, solana-rpc.ts - must build the exact
 * same `DecodeHints.knownTokenAccounts` for a loaded run, or a hint-less path's
 * unresolved `$0`/`asset: ""` copy of the same `dedupe_key` can win `merge()` over a
 * hinted path's correctly-resolved one, purely by arrival order/`LAYER_RANK`. These
 * tests drive the REAL `@x402-redteam/capture` package through the real adversary
 * server (not a direct decoder-level unit test - that's `record.test.ts`/
 * `capture/test/svm.test.ts`, U21's).
 */
describe("knownTokenAccounts wiring (real capture, real adversary server)", () => {
  let adversary: Adversary;

  beforeEach(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });

  afterEach(async () => {
    await adversary.close();
  });

  it("a plain SPL Transfer via /solana-rpc to a known owner's ATA resolves asset=USDC and the right USD", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "svm", run_id: "ktx-rpc-only" });
    const payTo = await normalRoutePayTo(adversary.baseUrl);

    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(MINT);
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint,
      owner: address(payTo),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: signer,
      amount: 2_000_000n,
    });
    const base64Tx = await buildSignedTx([ix], signer);

    const rpcRes = await fetch(`${adversary.baseUrl}/solana-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [base64Tx, { encoding: "base64" }],
      }),
    });
    expect(rpcRes.status).toBe(200);
    const rpcBody = (await rpcRes.json()) as { result?: string; error?: unknown };
    expect(rpcBody.error).toBeUndefined();

    const drain = adversary.drain();
    const payment = drain.payments.find((p) => p.scheme === "transfer" && p.to === payTo);
    expect(payment).toBeDefined();
    expect(payment?.asset).toBe(MINT);
    expect(payment?.asset_known).toBe(true);
    expect(payment?.amount_usd).toBe(2);
    expect(payment?.from).toBe(signer.address);
    expect(payment?.capture).toBe("rpc");
  });

  it("the same SVM tx via a PAYMENT-SIGNATURE header AND /solana-rpc merges keeping the resolved asset/USD", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "svm", run_id: "ktx-header-rpc" });
    const payTo = await normalRoutePayTo(adversary.baseUrl);

    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(MINT);
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint,
      owner: address(payTo),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: signer,
      amount: 3_000_000n,
    });
    const base64Tx = await buildSignedTx([ix], signer);

    // Header path: wraps the exact same transaction bytes in a v2 PaymentPayload and
    // submits it against the (unrelated-terms, but that's fine - this test cares about
    // resolution/merge, not delivery) `/normal` challenge.
    const headerPayload: PaymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: CHAIN_DEFAULTS.svm.network,
        asset: MINT,
        amount: "3000000",
        payTo,
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: { transaction: base64Tx },
    } as PaymentPayload;
    const header = encodePaymentSignatureHeader(headerPayload);
    const headerRes = await fetch(`${adversary.baseUrl}/normal`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    // Not necessarily 200 (this transaction doesn't pay /normal's own challenge terms -
    // see decode()'s binding check) - only that it decoded and was recorded.
    expect([200, 402]).toContain(headerRes.status);

    // Same bytes, submitted to the mock RPC too (the agent broadcasting what it signed -
    // ADR-013 dual capture).
    const rpcRes = await fetch(`${adversary.baseUrl}/solana-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [base64Tx, { encoding: "base64" }],
      }),
    });
    expect(rpcRes.status).toBe(200);

    const drain = adversary.drain();
    const matching = drain.payments.filter((p) => p.to === payTo && p.amount_atomic === "3000000");
    // Exactly one merged entry - header and rpc shared the same dedupe_key (identical
    // transaction bytes), so this is `merge()`'s job, not two separate payments.
    expect(matching).toHaveLength(1);
    const payment = matching[0];
    expect(payment?.capture).toBe("header+rpc");
    expect(payment?.asset).toBe(MINT);
    expect(payment?.asset_known).toBe(true);
    expect(payment?.amount_usd).toBe(3);
  });
});
