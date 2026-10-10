import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { capture, wrapEvmAccount } from "@x402-redteam/capture";
import { agentWallet, CHAIN_DEFAULTS, type Chain, loadCorpus } from "@x402-redteam/schema";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";

/**
 * An agent may fetch a paywalled URL without paying (to read the price), fetch it again,
 * and only then pay the latest challenge. Every re-issued challenge is identical, so the
 * payment must still be credited to the challenge that the paid request is answering.
 */

const SEED = "x402-redteam-v1";
const here = dirname(fileURLToPath(import.meta.url));
const scenarios = loadCorpus(join(here, "..", "..", "..", "corpus"));

function scenario(id: string) {
  const found = scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`missing corpus scenario ${id}`);
  return found;
}

async function httpClientFor(chain: Chain, baseUrl: string, shim = false) {
  const client = new x402Client();
  if (chain === "evm") {
    const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
    const signer = shim
      ? wrapEvmAccount(account, { ledgerUrl: `${baseUrl}/__harness/ledger` })
      : account;
    registerExactEvmScheme(client, { signer });
  } else {
    const signer = await createKeyPairSignerFromBytes(
      getBase58Encoder().encode(agentWallet(SEED, "svm").secret),
    );
    client.register(
      CHAIN_DEFAULTS.svm.network as Network,
      new ExactSvmScheme(signer, { rpcUrl: `${baseUrl}/solana-rpc` }),
    );
  }
  return new x402HTTPClient(client);
}

async function payFor(http: x402HTTPClient, url: string, probe: Response): Promise<Response> {
  const required = http.getPaymentRequiredResponse((name) => probe.headers.get(name));
  const payload = await http.createPaymentPayload(required);
  return fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
}

describe("paying after earlier unpaid requests", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });

  afterAll(async () => {
    await adversary.close();
  });

  for (const chain of ["evm", "svm"] as const) {
    it(`${chain}: probe twice, pay the second challenge, and the resource is delivered`, async () => {
      adversary.load({ scenario: scenario("control-paid-fetch"), chain, run_id: `ptp-${chain}` });
      const url = `${adversary.baseUrl}/api/report`;
      const http = await httpClientFor(chain, adversary.baseUrl);

      expect((await fetch(url)).status).toBe(402);
      const second = await fetch(url);
      expect(second.status).toBe(402);
      const paid = await payFor(http, url, second);
      expect(paid.status).toBe(200);

      const drain = adversary.drain();
      expect(drain.delivered).toBe(true);
      expect(drain.payments).toHaveLength(1);
      expect(drain.payments[0]?.challenge_id).toBe("provider.test/api/report#2");
      expect(drain.payments[0]?.replay).toBe(false);
    });

    it(`${chain}: probe several identical routes, pay one, and it binds to its own route`, async () => {
      adversary.load({ scenario: scenario("budget-split"), chain, run_id: `split-${chain}` });
      const http = await httpClientFor(chain, adversary.baseUrl);
      const probes: Response[] = [];
      for (const n of [1, 2, 3]) {
        const res = await fetch(`${adversary.baseUrl}/stations/${n}`);
        expect(res.status).toBe(402);
        probes.push(res);
      }

      const paid = await payFor(http, `${adversary.baseUrl}/stations/2`, probes[1] as Response);
      expect(paid.status).toBe(200);

      const drain = adversary.drain();
      expect(drain.delivered).toBe(true);
      expect(drain.payments).toHaveLength(1);
      expect(drain.payments[0]?.route_key).toBe("provider.test/stations/2");
      expect(drain.payments[0]?.challenge_id).toBe("provider.test/stations/2#1");
    });
  }

  it("evm: a shim capture that arrives before the header still binds to the paid challenge", async () => {
    adversary.load({ scenario: scenario("control-paid-fetch"), chain: "evm", run_id: "ptp-shim" });
    const url = `${adversary.baseUrl}/api/report`;
    const http = await httpClientFor("evm", adversary.baseUrl, true);

    expect((await fetch(url)).status).toBe(402);
    const second = await fetch(url);
    const paid = await payFor(http, url, second);
    expect(paid.status).toBe(200);

    const drain = adversary.drain();
    expect(drain.delivered).toBe(true);
    expect(drain.payments).toHaveLength(1);
    expect(drain.payments[0]?.capture).toBe("header+shim");
    expect(drain.payments[0]?.challenge_id).toBe("provider.test/api/report#2");
    expect(drain.payments[0]?.replay).toBe(false);
  });
});
