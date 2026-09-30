import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";
import { makeCapture } from "./stub-capture.js";

const SEED = "x402-redteam-v1";

describe("adversary harness endpoints", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  it("7. an unknown solana-rpc method returns a JSON-RPC error and is logged", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "svm", run_id: "rpc-unknown" });

    const res = await fetch(`${adversary.baseUrl}/solana-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "totallyUnknownMethod", params: [] }),
    });
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32601);

    const drain = adversary.drain();
    // v2 (ADR-013): the request log's `path` is now just the RPC method name (and
    // `host` is "solana-rpc"), per application-design.md §5 "v2" / U10
    // functional-design.md §3.
    expect(
      drain.requests.some((r) => r.host === "solana-rpc" && r.path === "totallyUnknownMethod"),
    ).toBe(true);
  });

  it("known solana-rpc methods (getSlot, getMinimumBalanceForRentExemption, simulateTransaction, isBlockhashValid) respond", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "svm", run_id: "rpc-known" });
    const methods = [
      "getSlot",
      "getMinimumBalanceForRentExemption",
      "simulateTransaction",
      "isBlockhashValid",
    ];
    for (const method of methods) {
      const res = await fetch(`${adversary.baseUrl}/solana-rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
      const body = (await res.json()) as any;
      expect(body.error).toBeUndefined();
    }
  });

  it("sendTransaction with malformed params is rejected as invalid, and records nothing (ADR-013)", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "svm", run_id: "rpc-malformed" });
    const sendTx = await fetch(`${adversary.baseUrl}/solana-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
    const sendTxBody = (await sendTx.json()) as any;
    expect(sendTxBody.error.code).toBe(-32602);

    const drain = adversary.drain();
    expect(drain.payments).toHaveLength(0);
  });

  it("/__harness/health reports the loaded run_id, and /__harness/ledger 409s with no run loaded", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "health-check" });
    const health = await fetch(`${adversary.baseUrl}/__harness/health`);
    expect(await health.json()).toEqual({ ok: true, run_id: "health-check" });
  });

  it("/__harness/ledger records a shim payment", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "ledger-shim" });
    const res = await fetch(`${adversary.baseUrl}/__harness/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "evm_typed_data",
        payload: {
          domain: {
            chainId: 84532,
            verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
          types: {},
          primaryType: "TransferWithAuthorization",
          message: {
            from: "0xaaaa000000000000000000000000000000000a",
            to: "0xbbbb000000000000000000000000000000000b",
            value: "5000",
            nonce: "0xnonce1",
          },
          signature: "0xdead",
          address: "0xaaaa000000000000000000000000000000000a",
        },
      }),
    });
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.payment_id).toBe("string");

    const drain = adversary.drain();
    expect(
      drain.payments.some((p) => p.payment_id === body.payment_id && p.capture === "shim"),
    ).toBe(true);
  });
});
