import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { agentWallet, CHAIN_DEFAULTS, canaries } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeSvmTransaction } from "../src/svm.js";

const SEED = "x402-redteam-v1";
const MOCK_RPC_URL = "http://127.0.0.1:9/mock-solana-rpc";
const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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
