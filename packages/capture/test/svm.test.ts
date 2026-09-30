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
import { getTransferSolInstruction } from "@solana-program/system";
import {
  AuthorityType,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getApproveInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  agentWallet,
  CHAIN_DEFAULTS,
  canaries,
  FIXED_BLOCKHASH,
  NATIVE_ASSET,
} from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeSvmTransaction } from "../src/svm.js";

const SEED = "x402-redteam-v1";
const MOCK_RPC_URL = "http://127.0.0.1:9/mock-solana-rpc";

function mintAccountBase64(decimals: number): string {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1; // isInitialized
  return Buffer.from(data).toString("base64");
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "getAccountInfo") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            context: { slot: 1 },
            value: {
              data: [mintAccountBase64(CHAIN_DEFAULTS.svm.decimals), "base64"],
              executable: false,
              lamports: 1461600,
              owner: TOKEN_PROGRAM_ADDRESS,
              rentEpoch: 0,
              space: 82,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected offline test hit the mock Solana RPC: ${body.method}`);
    // biome-ignore lint/suspicious/noExplicitAny: stubbing the global fetch signature for the test only.
  }) as any;
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function buildRealSvmPayment(): Promise<{
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}> {
  const wallet = agentWallet(SEED, "svm");
  const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
  const owner = canaries(SEED, "svm-test", "svm").get("legit").address;
  const feePayer = canaries(SEED, "svm-test", "svm").get("facilitator").address;

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: CHAIN_DEFAULTS.svm.network as PaymentRequirements["network"],
    asset: CHAIN_DEFAULTS.svm.asset,
    amount: "1000",
    payTo: owner,
    maxTimeoutSeconds: 60,
    extra: {
      feePayer,
      // 32 zero bytes (the Solana System Program address), used as a
      // deterministic offline blockhash so no RPC round-trip is needed.
      recentBlockhash: "11111111111111111111111111111111",
    },
  };

  const scheme = new ExactSvmScheme(signer, { rpcUrl: MOCK_RPC_URL });
  const result = await scheme.createPaymentPayload(2, requirements);
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: result.payload,
  };
  return { payload, requirements };
}

/** Builds and signs an arbitrary set of instructions into one transaction, offline (fixed
 * blockhash) - used by the H1 (multi-leg) and M2 (approve/SetAuthority) tests below. */
// biome-ignore lint/suspicious/noExplicitAny: instruction list shape varies by builder.
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

describe("decodeSvmTransaction: H1 (code review) multi-leg detection", () => {
  it("decodes two TransferChecked instructions in one transaction as two legs", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const ownerA = canaries(SEED, "svm-h1", "svm").get("legit").address;
    const ownerB = canaries(SEED, "svm-h1", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destA] = await findAssociatedTokenPda({
      mint,
      owner: address(ownerA),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destB] = await findAssociatedTokenPda({
      mint,
      owner: address(ownerB),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix1 = getTransferCheckedInstruction({
      source: sourceAta,
      mint,
      destination: destA,
      authority: signer,
      amount: 1000n,
      decimals: 6,
    });
    const ix2 = getTransferCheckedInstruction({
      source: sourceAta,
      mint,
      destination: destB,
      authority: signer,
      amount: 2000n,
      decimals: 6,
    });

    const base64 = await buildSignedTx([ix1, ix2], signer);
    const decoded = await decodeSvmTransaction(base64, { knownOwners: [ownerA, ownerB] });

    expect(decoded.legs).toHaveLength(2);
    expect(decoded.legs?.[0]?.to).toBe(ownerA);
    expect(decoded.legs?.[0]?.amount_atomic).toBe("1000");
    expect(decoded.legs?.[0]?.valid).toBe(true);
    expect(decoded.legs?.[1]?.to).toBe(ownerB);
    expect(decoded.legs?.[1]?.amount_atomic).toBe("2000");
    expect(decoded.legs?.[1]?.valid).toBe(true);
    expect(decoded.legs?.[0]?.dedupe_key).not.toBe(decoded.legs?.[1]?.dedupe_key);
    // Top-level fields mirror the first leg.
    expect(decoded.to).toBe(ownerA);
  });

  it("decodes a plain (legacy) Transfer instruction - unresolved owner, unknown asset", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const owner = canaries(SEED, "svm-h1", "svm").get("legit").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint,
      owner: address(owner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: signer,
      amount: 500n,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64, { knownOwners: [owner] });

    expect(decoded.scheme).toBe("transfer");
    expect(decoded.asset).toBe("");
    expect(decoded.amount_atomic).toBe("500");
    expect(decoded.from).toBe(signer.address);
    expect(decoded.to).toBe(destAta);
    expect(decoded.invalid_reason).toBe("unresolved_owner");
  });

  it("decodes a System Program native transfer - asset NATIVE_ASSET, scheme transfer", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const destination = canaries(SEED, "svm-h1", "svm").get("legit").address;

    const ix = getTransferSolInstruction({
      source: signer,
      destination: address(destination),
      amount: 777n,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.scheme).toBe("transfer");
    expect(decoded.asset).toBe(NATIVE_ASSET);
    expect(decoded.amount_atomic).toBe("777");
    expect(decoded.from).toBe(signer.address);
    expect(decoded.to).toBe(destination);
    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBeUndefined();
  });

  it("decodes SPL Approve - scheme approve, to = delegate", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const delegate = canaries(SEED, "svm-h1", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getApproveInstruction({
      source: sourceAta,
      delegate: address(delegate),
      owner: signer,
      amount: 9999n,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.scheme).toBe("approve");
    expect(decoded.asset).toBe("");
    expect(decoded.from).toBe(signer.address);
    expect(decoded.to).toBe(delegate);
    expect(decoded.amount_atomic).toBe("9999");
    expect(decoded.valid).toBe(true);
  });

  it("decodes SPL ApproveChecked - scheme approve, asset = mint (known)", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const delegate = canaries(SEED, "svm-h1", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getApproveCheckedInstruction({
      source: sourceAta,
      mint,
      delegate: address(delegate),
      owner: signer,
      amount: 4242n,
      decimals: 6,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.scheme).toBe("approve");
    expect(decoded.asset).toBe(CHAIN_DEFAULTS.svm.asset);
    expect(decoded.to).toBe(delegate);
    expect(decoded.amount_atomic).toBe("4242");
    expect(decoded.valid).toBe(true);
  });

  it("decodes SPL SetAuthority - scheme approve, to = new authority, amount 0", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-h1", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getSetAuthorityInstruction({
      owned: sourceAta,
      owner: signer,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: address(newAuthority),
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.scheme).toBe("approve");
    expect(decoded.to).toBe(newAuthority);
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.valid).toBe(true);
  });
});

describe("decodeSvmTransaction (real @x402/svm exact client)", () => {
  it("resolves the owner via hints and reports a valid signature", async () => {
    const { payload, requirements } = await buildRealSvmPayment();
    const owner = requirements.payTo;

    const decoded = await decodeSvmTransaction(
      (payload.payload as { transaction: string }).transaction,
      { knownOwners: [owner] },
      { network: requirements.network, scheme: requirements.scheme },
    );

    expect(decoded.chain).toBe("svm");
    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBeUndefined();
    expect(decoded.asset).toBe(requirements.asset);
    expect(decoded.amount_atomic).toBe(requirements.amount);
    expect(decoded.to).toBe(owner);
    expect(decoded.from).toBe(agentWallet(SEED, "svm").address);
    expect(decoded.to_token_account).toBeDefined();
    expect(decoded.to_token_account).not.toBe(owner);
    expect(decoded.dedupe_key).toMatch(/^svm:/);
  });

  it("gives unresolved_owner when no hint matches, while valid still reflects the signature check", async () => {
    const { payload, requirements } = await buildRealSvmPayment();

    const decoded = await decodeSvmTransaction(
      (payload.payload as { transaction: string }).transaction,
      { knownOwners: [] },
      { network: requirements.network, scheme: requirements.scheme },
    );

    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBe("unresolved_owner");
    expect(decoded.to).toBe(decoded.to_token_account);
  });

  it("defaults to devnet network and exact scheme when no opts are given (shim path default)", async () => {
    const { payload } = await buildRealSvmPayment();
    const decoded = await decodeSvmTransaction(
      (payload.payload as { transaction: string }).transaction,
    );
    expect(decoded.network).toBe(CHAIN_DEFAULTS.svm.network);
    expect(decoded.scheme).toBe("exact");
  });
});
