import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
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
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { capture } from "@x402-redteam/capture";
import { agentWallet, CHAIN_DEFAULTS, FIXED_BLOCKHASH } from "@x402-redteam/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";

/**
 * Uses the real `@x402-redteam/capture` package - `test/stub-capture.ts`'s
 * `decodeShimEvent("svm_tx")` trusts the accepted payTo/amount rather than fully
 * decoding the transaction; these tests need the real ATA/decimals-aware decode.
 */
const SEED = "x402-redteam-v1";

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC `result` is intentionally untyped here - each test narrows what it needs.
  result?: any;
  error?: { code: number; message: string };
}

async function jsonRpc(
  baseUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<JsonRpcResponse> {
  const res = await fetch(`${baseUrl}/solana-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json() as Promise<JsonRpcResponse>;
}

/** Builds and signs a real TransferChecked transaction, offline (fixed blockhash). */
async function buildSignedTransfer(to: string, amountAtomic: bigint): Promise<string> {
  const wallet = agentWallet(SEED, "svm");
  const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
  const mint = address(CHAIN_DEFAULTS.svm.asset);
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const [sourceAta] = await findAssociatedTokenPda({ mint, owner: signer.address, tokenProgram });
  const [destinationAta] = await findAssociatedTokenPda({
    mint,
    owner: address(to),
    tokenProgram,
  });

  const transferIx = getTransferCheckedInstruction(
    {
      source: sourceAta,
      mint,
      destination: destinationAta,
      authority: signer,
      amount: amountAtomic,
      decimals: CHAIN_DEFAULTS.svm.decimals,
    },
    { programAddress: tokenProgram },
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(FIXED_BLOCKHASH), lastValidBlockHeight: 0n },
        tx,
      ),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
  );

  const signedTransaction = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signedTransaction);
}

describe("mock Solana JSON-RPC v2 additions (ADR-013)", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });

  afterAll(async () => {
    await adversary.close();
  });

  function load(run_id: string): void {
    adversary.load({ scenario: buildFixtureScenario(), chain: "svm", run_id: `svm-rpc-${run_id}` });
  }

  it("getBalance returns a fixed lamports balance", async () => {
    load("balance");
    const res = await jsonRpc(adversary.baseUrl, "getBalance", ["someaddr"]);
    expect(res.result.value).toBe(1_000_000_000);
  });

  it("getTokenAccountBalance returns the modelled wallet balance for a known mint", async () => {
    load("token-balance");
    const res = await jsonRpc(adversary.baseUrl, "getTokenAccountBalance", ["someTokenAcct"]);
    expect(res.result.value.decimals).toBe(6);
    expect(res.result.value.amount).toBe("100000000"); // $100 at 6 decimals
  });

  it("getAccountInfo returns the mint with assetInfo-resolved decimals", async () => {
    load("mint-info");
    const res = await jsonRpc(adversary.baseUrl, "getAccountInfo", [CHAIN_DEFAULTS.svm.asset]);
    expect(res.result.value).not.toBeNull();
    expect(res.result.value.owner).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("getSignatureStatuses reports finalized for a signature seen this run, null otherwise", async () => {
    load("sig-status");
    const to = agentWallet(SEED, "svm").address; // any valid pubkey works as a destination owner
    const transactionBase64 = await buildSignedTransfer(to, 1000n);

    const sendRes = await jsonRpc(adversary.baseUrl, "sendTransaction", [
      transactionBase64,
      { encoding: "base64" },
    ]);
    expect(sendRes.error).toBeUndefined();
    const signature = sendRes.result as string;

    const statuses = await jsonRpc(adversary.baseUrl, "getSignatureStatuses", [
      [signature, "11111111111111111111111111111111111111111111111111111111111111"],
    ]);
    expect(statuses.result.value[0].confirmationStatus).toBe("finalized");
    expect(statuses.result.value[1]).toBeNull();
  });

  it("sendTransaction (base64) decodes, records a Payment (capture: rpc), and a resubmission merges", async () => {
    load("send-base64");
    const to = agentWallet(SEED, "svm").address;
    const transactionBase64 = await buildSignedTransfer(to, 2500n);

    const first = await jsonRpc(adversary.baseUrl, "sendTransaction", [
      transactionBase64,
      { encoding: "base64" },
    ]);
    expect(typeof first.result).toBe("string");

    // Resubmitting the identical signed tx merges (same dedupe_key = message hash).
    await jsonRpc(adversary.baseUrl, "sendTransaction", [
      transactionBase64,
      { encoding: "base64" },
    ]);

    const drain = adversary.drain();
    const payments = drain.payments.filter((p) => p.amount_atomic === "2500");
    expect(payments).toHaveLength(1);
    expect(payments[0]?.capture).toBe("rpc");
  });

  it("sendTransaction (base58, no encoding param) also decodes and records", async () => {
    load("send-base58");
    const to = agentWallet(SEED, "svm").address;
    const transactionBase64 = await buildSignedTransfer(to, 3300n);
    const { getBase58Decoder } = await import("@solana/kit");
    const base58 = getBase58Decoder().decode(Buffer.from(transactionBase64, "base64"));

    const res = await jsonRpc(adversary.baseUrl, "sendTransaction", [base58]);
    expect(res.error).toBeUndefined();
    expect(typeof res.result).toBe("string");

    const drain = adversary.drain();
    expect(drain.payments.some((p) => p.amount_atomic === "3300")).toBe(true);
  });

  it("sendTransaction rejects malformed input with -32602 and records nothing", async () => {
    load("send-malformed");
    const res = await jsonRpc(adversary.baseUrl, "sendTransaction", [
      "not-a-real-transaction!!",
      { encoding: "base64" },
    ]);
    expect(res.error?.code).toBe(-32602);
    const drain = adversary.drain();
    expect(drain.payments).toHaveLength(0);
  });

  it("a real @solana/kit send + poll getSignatureStatuses flow terminates (sendAndConfirmTransaction-style)", async () => {
    load("real-kit-confirm");
    const to = agentWallet(SEED, "svm").address;
    const transactionBase64 = await buildSignedTransfer(to, 4400n);

    const rpc = createSolanaRpc(`${adversary.baseUrl}/solana-rpc`);
    // biome-ignore lint/suspicious/noExplicitAny: @solana/kit's Rpc<...> is generically typed per method set
    const signature = await (rpc as any)
      .sendTransaction(transactionBase64, { encoding: "base64" })
      .send();
    expect(typeof signature).toBe("string");

    // The mock always confirms immediately (deterministic, no real network delay), so a
    // single poll suffices - a real `sendAndConfirmTransactionFactory` additionally needs
    // `rpcSubscriptions` (WebSocket), which this offline-only harness doesn't provide.
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const statuses = await (rpc as any).getSignatureStatuses([signature]).send();
    expect(statuses.value[0].confirmationStatus).toBe("finalized");
  });
});
