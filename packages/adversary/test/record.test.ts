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
  AuthorityType,
  findAssociatedTokenPda,
  getSetAuthorityInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { capture, decodeSvmTransaction } from "@x402-redteam/capture";
import {
  agentWallet,
  CHAIN_DEFAULTS,
  canaries,
  type DecodedPayment,
  FIXED_BLOCKHASH,
  NATIVE_ASSET,
  walletBalanceUsd,
} from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { buildKnownTokenAccounts, recordDecoded, recordDecodedLegs } from "../src/record.js";
import { RunState } from "../src/state.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";
import { makeCapture } from "./stub-capture.js";

const SEED = "x402-redteam-v1";

/** Builds and signs one instruction into a transaction, offline (fixed blockhash) -
 * mirrors packages/capture/test/svm.test.ts's identical helper, kept local to avoid a
 * cross-package test import. */
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

const SVM_MINT = CHAIN_DEFAULTS.svm.asset;

function baseLeg(overrides: Partial<DecodedPayment>): DecodedPayment {
  return {
    chain: "svm",
    network: CHAIN_DEFAULTS.svm.network,
    scheme: "approve",
    asset: "",
    from: "agent",
    to: "attacker",
    amount_atomic: "0",
    dedupe_key: "svm:test",
    valid: true,
    raw: {},
    ...overrides,
  };
}

function newState(walletBalance?: number) {
  const scenario = buildFixtureScenario();
  if (walletBalance !== undefined) {
    scenario.task.wallet_balance_usd = walletBalance;
  }
  return new RunState(scenario, "svm", "run-u21-test");
}

describe("recordDecoded: U21 (capture lows) - SetAuthority authority_grant valuation", () => {
  it("values an authority_grant leg at the modelled wallet balance (default $100)", () => {
    const state = newState();
    const decoded = baseLeg({ authority_grant: true });

    const payment = recordDecoded(state, makeCapture(), decoded, { capture: "rpc" });

    expect(payment.scheme).toBe("approve");
    expect(payment.amount_usd).toBe(walletBalanceUsd(state.scenario.task));
    expect(payment.amount_usd).toBe(100);
  });

  it("values it at a scenario's own wallet_balance_usd, capped the same way an approve is", () => {
    const state = newState(250);
    const decoded = baseLeg({ authority_grant: true });

    const payment = recordDecoded(state, makeCapture(), decoded, { capture: "rpc" });

    expect(payment.amount_usd).toBe(250);
  });

  it("MintTokens/FreezeAccount-style legs (authority_grant absent) are unaffected - still $0", () => {
    const state = newState();
    const decoded = baseLeg({ authority_grant: undefined });

    const payment = recordDecoded(state, makeCapture(), decoded, { capture: "rpc" });

    expect(payment.amount_usd).toBe(0);
  });

  it("an ordinary approve (not an authority grant) is still capped at the wallet balance, not valued at it", () => {
    const state = newState();
    // approve(MAX_UINT256)-style: huge amount_atomic, no authority_grant - this is the
    // existing ADR-015 cap behaviour and must be unaffected by the authority_grant path.
    const decoded = baseLeg({
      asset: SVM_MINT,
      amount_atomic: "999999999999999999",
    });

    const payment = recordDecoded(state, makeCapture(), decoded, { capture: "rpc" });

    expect(payment.amount_usd).toBe(walletBalanceUsd(state.scenario.task));
  });
});

describe("recordDecoded: U21 (capture lows) - plain SPL Transfer asset resolution", () => {
  it("a resolved asset (known mint) computes USD normally and is asset_known: true", () => {
    const state = newState();
    const decoded = baseLeg({
      scheme: "transfer",
      asset: SVM_MINT,
      amount_atomic: "2000000",
      invalid_reason: undefined,
    });

    const payment = recordDecoded(state, makeCapture(), decoded, { capture: "rpc" });

    expect(payment.amount_usd).toBe(2);
    expect(payment.asset_known).toBe(true);
    expect(payment.invalid_reason).toBeUndefined();
  });

  it("an unresolved asset stays asset_known: false with a clear invalid_reason", () => {
    const state = newState();
    const decoded = baseLeg({
      scheme: "transfer",
      asset: "",
      amount_atomic: "500",
      invalid_reason: "unresolved_owner",
    });

    const payment = recordDecoded(state, makeCapture(), decoded, { capture: "rpc" });

    expect(payment.asset_known).toBe(false);
    expect(payment.invalid_reason).toBe("unresolved_owner");
  });
});

describe("buildKnownTokenAccounts", () => {
  it("builds owner x mint -> ATA, matching the real derivation", async () => {
    const owner = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    const map = await buildKnownTokenAccounts([owner], [SVM_MINT]);

    const [expectedAta] = await findAssociatedTokenPda({
      mint: address(SVM_MINT),
      owner: address(owner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    expect(map[expectedAta]).toEqual({ owner, mint: SVM_MINT });
    // 2, not 1: M1 (code review) derives the ATA under both token programs - see the
    // next test for the explicit TOKEN_2022_PROGRAM_ADDRESS assertion.
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("M1 (code review): derives the ATA under BOTH TOKEN_PROGRAM_ADDRESS and TOKEN_2022_PROGRAM_ADDRESS", async () => {
    const owner = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    const map = await buildKnownTokenAccounts([owner], [SVM_MINT]);

    const [classicAta] = await findAssociatedTokenPda({
      mint: address(SVM_MINT),
      owner: address(owner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [token2022Ata] = await findAssociatedTokenPda({
      mint: address(SVM_MINT),
      owner: address(owner),
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    expect(classicAta).not.toBe(token2022Ata);
    expect(map[classicAta]).toEqual({ owner, mint: SVM_MINT });
    expect(map[token2022Ata]).toEqual({ owner, mint: SVM_MINT });
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("skips NATIVE_ASSET (no ATA for SOL) without throwing", async () => {
    const owner = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    const map = await buildKnownTokenAccounts([owner], [NATIVE_ASSET, SVM_MINT]);

    // 2, not 4: NATIVE_ASSET never derives an ATA under either token program.
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("skips a malformed owner/mint address rather than throwing", async () => {
    const map = await buildKnownTokenAccounts(["not-a-real-address"], [SVM_MINT]);
    expect(map).toEqual({});
  });
});

describe("L7 (code review): real decodeSvmTransaction output piped into recordDecoded", () => {
  it("a real, signed SetAuthority(AccountOwner) transaction is recorded at the modelled wallet balance", async () => {
    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const mint = address(SVM_MINT);
    const newAuthority = canaries(SEED, "svm-u21-e2e", "svm").get("attacker").address;
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
    // Real knownTokenAccounts, the real capture.decodePayload-equivalent decoder, and
    // the real CaptureApi (attribute/merge) - no stub-capture.ts anywhere in this test.
    const knownTokenAccounts = await buildKnownTokenAccounts([signer.address], [SVM_MINT]);
    const decoded = await decodeSvmTransaction(base64, { knownTokenAccounts });

    expect(decoded.authority_grant).toBe(true);
    expect(decoded.asset).toBe(SVM_MINT);

    const state = newState();
    const [payment] = recordDecodedLegs(state, capture, decoded, { capture: "rpc" });

    expect(payment?.scheme).toBe("approve");
    expect(payment?.amount_usd).toBe(walletBalanceUsd(state.scenario.task));
    expect(payment?.amount_usd).toBe(100);
    expect(payment?.asset_known).toBe(true);
  });
});
