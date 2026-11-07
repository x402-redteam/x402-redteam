import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { capture } from "@x402-redteam/capture";
import { agentWallet } from "@x402-redteam/schema";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { RunState } from "../src/state.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";

// U37 (C2, D2, AC-1, AC-13): the facilitator reads signatures against the offered terms, the
// merged ledger entry keeps the strongest reading in either arrival order, and two
// authorizations that share a nonce are two payments.
const SEED = "x402-redteam-v1";
const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);

describe("U37 facilitator and nonce reuse (real capture)", () => {
  let adversary: Adversary;
  let n = 0;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });
  afterAll(async () => {
    await adversary.close();
  });

  async function challenge(route = "/normal") {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: `evm-u37-${n++}` });
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    const http = new x402HTTPClient(client);
    const unpaid = await fetch(`${adversary.baseUrl}${route}`);
    const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name));
    const payload = await http.createPaymentPayload(required);
    return { http, required, payload };
  }

  const verify = (paymentPayload: PaymentPayload) =>
    fetch(`${adversary.baseUrl}/facilitator/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload }),
    });

  it("AC-13: /verify then the header, and the reverse, both end in one offered entry", async () => {
    for (const order of ["verify-first", "header-first"] as const) {
      const { http, payload } = await challenge();
      const headers = http.encodePaymentSignatureHeader(payload);
      if (order === "verify-first") {
        expect((await verify(payload)).status).toBe(200);
        expect((await fetch(`${adversary.baseUrl}/normal`, { headers })).status).toBe(200);
      } else {
        expect((await fetch(`${adversary.baseUrl}/normal`, { headers })).status).toBe(200);
        expect((await verify(payload)).status).toBe(200);
      }
      const payments = adversary.drain().payments;
      expect(payments).toHaveLength(1);
      expect(payments[0]?.terms_verified).toBe("offered");
      expect(payments[0]?.valid).toBe(true);
    }
  });

  it("AC-13: /verify alone records offered", async () => {
    const { payload } = await challenge();
    await verify(payload);
    const payments = adversary.drain().payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]?.capture).toBe("header");
    expect(payments[0]?.terms_verified).toBe("offered");
  });

  it("AC-1: two authorizations sharing a nonce but not a payee are two payments", async () => {
    const { http, required, payload } = await challenge();
    const inner = payload.payload as unknown as {
      authorization: Record<string, string> & {
        value: string;
        validAfter: string;
        validBefore: string;
      };
      signature: string;
    };
    const accepted = required.accepts[0] as unknown as {
      asset: string;
      network: string;
      extra: { name: string; version: string };
    };
    const other = "0x000000000000000000000000000000000000dEaD" as const;
    const message = {
      from: inner.authorization.from as `0x${string}`,
      to: other,
      value: BigInt(inner.authorization.value),
      validAfter: BigInt(inner.authorization.validAfter),
      validBefore: BigInt(inner.authorization.validBefore),
      nonce: inner.authorization.nonce as `0x${string}`,
    };
    const signature = await account.signTypedData({
      domain: {
        name: accepted.extra.name,
        version: accepted.extra.version,
        chainId: Number(accepted.network.split(":")[1]),
        verifyingContract: accepted.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message,
    });
    const second = {
      ...payload,
      payload: { signature, authorization: { ...inner.authorization, to: other } },
    } as PaymentPayload;
    await fetch(`${adversary.baseUrl}/normal`, {
      headers: http.encodePaymentSignatureHeader(payload),
    });
    await fetch(`${adversary.baseUrl}/normal`, {
      headers: http.encodePaymentSignatureHeader(second),
    });
    const payments = adversary.drain().payments;
    expect(payments).toHaveLength(2);
    expect(new Set(payments.map((p) => p.dedupe_key)).size).toBe(2);
    expect(payments.every((p) => p.valid)).toBe(true);
  });
});

describe("D2: RunState exposes the union of every route's current issuance", () => {
  it("unions currentChallengeIds across routes", () => {
    const state = new RunState(buildFixtureScenario(), "evm", "u37-state");
    expect(state.currentChallengeIdsAllRoutes()).toEqual([]);
    state.runtimeFor("a").currentChallengeIds.push("a#0", "a#1");
    state.runtimeFor("b").currentChallengeIds.push("b#0", "a#1");
    expect(state.currentChallengeIdsAllRoutes().sort()).toEqual(["a#0", "a#1", "b#0"]);
  });
});
