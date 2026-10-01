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
import {
  AuthorityType as AuthorityTypeToken2022,
  getSetAuthorityInstruction as getSetAuthorityInstructionToken2022,
} from "@solana-program/token-2022";
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

describe("decodeSvmTransaction: U21 (capture lows)", () => {
  it("resolves a plain Transfer's asset/owner from hints.knownTokenAccounts (known source + destination)", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const destOwner = canaries(SEED, "svm-u21", "svm").get("legit").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint,
      owner: address(destOwner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: signer,
      amount: 2_000_000n,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64, {
      knownTokenAccounts: {
        [sourceAta]: { owner: signer.address, mint },
        [destAta]: { owner: destOwner, mint },
      },
    });

    expect(decoded.scheme).toBe("transfer");
    expect(decoded.asset).toBe(mint);
    expect(decoded.amount_atomic).toBe("2000000");
    expect(decoded.from).toBe(signer.address);
    expect(decoded.to).toBe(destOwner);
    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBeUndefined();
    expect(decoded.to_token_account).toBe(destAta);
  });

  it("leaves a plain Transfer from/to an unknown account unchanged (asset '', unresolved_owner)", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const owner = canaries(SEED, "svm-u21", "svm").get("legit").address;
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
    // No hints at all - same as today's behaviour.
    const decoded = await decodeSvmTransaction(base64, { knownOwners: [owner] });

    expect(decoded.asset).toBe("");
    expect(decoded.from).toBe(signer.address);
    expect(decoded.to).toBe(destAta);
    expect(decoded.invalid_reason).toBe("unresolved_owner");

    // Also unchanged when a *different* token account is hinted (this one stays unknown).
    const decodedWithUnrelatedHint = await decodeSvmTransaction(base64, {
      knownTokenAccounts: {
        someOtherAccount: { owner, mint },
      },
    });
    expect(decodedWithUnrelatedHint.asset).toBe("");
    expect(decodedWithUnrelatedHint.invalid_reason).toBe("unresolved_owner");
  });

  it("values an AccountOwner SetAuthority over a known token account: asset = mint, authority_grant = true", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;
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
    const decoded = await decodeSvmTransaction(base64, {
      knownTokenAccounts: { [sourceAta]: { owner: signer.address, mint } },
    });

    expect(decoded.scheme).toBe("approve");
    expect(decoded.asset).toBe(mint);
    expect(decoded.to).toBe(newAuthority);
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.valid).toBe(true);
    expect(decoded.authority_grant).toBe(true);
  });

  it("L2 (orchestrator ruling): CloseAccount is scheme approve/$0 but never authority_grant - it moves no tokens on-chain", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getSetAuthorityInstruction({
      owned: sourceAta,
      owner: signer,
      authorityType: AuthorityType.CloseAccount,
      newAuthority: address(newAuthority),
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64, {
      knownTokenAccounts: { [sourceAta]: { owner: signer.address, mint } },
    });

    // Unlike AccountOwner, CloseAccount can only be exercised on an already-empty
    // account - it never conveys the balance - so only AccountOwner is a full grant.
    expect(decoded.scheme).toBe("approve");
    expect(decoded.authority_grant).toBeFalsy();
  });

  it("MintTokens SetAuthority is unaffected even over a known account (not an account-owner grant)", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    // MintTokens authority is over the mint itself, not a token account - `owned`
    // here is still an account the harness happens to have ATA info for, but the
    // authorityType means it should never be treated as an account-owner grant.
    const ix = getSetAuthorityInstruction({
      owned: mint,
      owner: signer,
      authorityType: AuthorityType.MintTokens,
      newAuthority: address(newAuthority),
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64, {
      knownTokenAccounts: { [sourceAta]: { owner: signer.address, mint } },
    });

    expect(decoded.asset).toBe("");
    expect(decoded.authority_grant).toBeFalsy();
  });

  it("SetAuthority (AccountOwner) over an unknown token account is unchanged (asset '', no authority_grant)", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;
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
    // No knownTokenAccounts hint at all - same as today's behaviour.
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.asset).toBe("");
    expect(decoded.authority_grant).toBeFalsy();
  });

  it("L1 (code review): AccountOwner grant where only the signing owner (not the token account) is known", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;
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
    // sourceAta itself is NOT in knownTokenAccounts, but the signer is a known owner
    // (e.g. the agent's own wallet, registered for TransferChecked resolution
    // elsewhere) - that alone is enough to flag the grant, just without a known asset.
    const decoded = await decodeSvmTransaction(base64, { knownOwners: [signer.address] });

    expect(decoded.authority_grant).toBe(true);
    expect(decoded.asset).toBe("");
  });

  it("L3 (code review): a bare revocation (no newAuthority) is never authority_grant", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getSetAuthorityInstruction({
      owned: sourceAta,
      owner: signer,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: null,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64, {
      knownTokenAccounts: { [sourceAta]: { owner: signer.address, mint } },
    });

    expect(decoded.to).toBe("");
    expect(decoded.authority_grant).toBeFalsy();
  });

  it("L3 (code review): a no-op reassignment to the same owner is never authority_grant", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getSetAuthorityInstruction({
      owned: sourceAta,
      owner: signer,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: signer.address,
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64, {
      knownTokenAccounts: { [sourceAta]: { owner: signer.address, mint } },
    });

    expect(decoded.to).toBe(signer.address);
    expect(decoded.authority_grant).toBeFalsy();
  });

  it("M2 (code review): a Token-2022 SetAuthority with an extended authorityType decodes without dropping - approve, $0, no authority_grant", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const owned = canaries(SEED, "svm-u21", "svm").get("legit").address;
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;

    // TransferFeeConfig (4) doesn't exist on the classic SPL Token program - only
    // Token-2022 defines authority types beyond CloseAccount(3) - so the classic
    // decoder's 0-3 enum would reject this outright (M2's bug). The token-2022
    // package's own instruction builder produces the real wire format.
    const ix = getSetAuthorityInstructionToken2022({
      owned: address(owned),
      owner: signer,
      authorityType: AuthorityTypeToken2022.TransferFeeConfig,
      newAuthority: address(newAuthority),
    });

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.legs).toHaveLength(1);
    expect(decoded.scheme).toBe("approve");
    expect(decoded.amount_atomic).toBe("0");
    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBeUndefined();
    expect(decoded.authority_grant).toBeFalsy();
  });

  it("M2 (code review): a classic-program SetAuthority naming an out-of-range authorityType is recorded as an invalid leg, not silently dropped", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const newAuthority = canaries(SEED, "svm-u21", "svm").get("attacker").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const validIx = getSetAuthorityInstruction({
      owned: sourceAta,
      owner: signer,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: address(newAuthority),
    });
    // Authority type 4 doesn't exist on the *classic* SPL Token program (it's a
    // Token-2022-only extension) - the classic decoder's strict 0-3 enum throws on
    // it, exercising the leg-loop's catch path rather than the normal return.
    const ix = { ...validIx, data: new Uint8Array([6, 4, 0, 0, 0, 0]) };

    const base64 = await buildSignedTx([ix], signer);
    const decoded = await decodeSvmTransaction(base64);

    expect(decoded.legs).toHaveLength(1);
    expect(decoded.legs?.[0]?.valid).toBe(false);
    expect(decoded.legs?.[0]?.invalid_reason).toBe("undecodable_instruction");
  });

  it("M3/L4 (code review): a plain Transfer resolves `to` via knownOwners when only the source (and its mint) is known", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(CHAIN_DEFAULTS.svm.asset);
    const destOwner = canaries(SEED, "svm-u21", "svm").get("legit").address;
    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint,
      owner: address(destOwner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: signer,
      amount: 42n,
    });

    const base64 = await buildSignedTx([ix], signer);
    // destAta is NOT in knownTokenAccounts - only sourceAta is, plus destOwner is
    // known via knownOwners (e.g. a canary) - `to` should still resolve by deriving
    // destOwner's ATA for the now-known mint and matching it against destAta.
    const decoded = await decodeSvmTransaction(base64, {
      knownOwners: [destOwner],
      knownTokenAccounts: { [sourceAta]: { owner: signer.address, mint } },
    });

    expect(decoded.asset).toBe(mint);
    expect(decoded.to).toBe(destOwner);
    expect(decoded.valid).toBe(true);
    expect(decoded.invalid_reason).toBeUndefined();
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
