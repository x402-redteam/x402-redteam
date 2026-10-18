import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { agentWallet, CHAIN_DEFAULTS, canaries } from "@x402-redteam/schema";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { capture } from "../src/index.js";

const SEED = "x402-redteam-v1";

function requirements(
  extra: Record<string, unknown> = CHAIN_DEFAULTS.evm.extra,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: CHAIN_DEFAULTS.evm.network as PaymentRequirements["network"],
    asset: CHAIN_DEFAULTS.evm.asset,
    amount: "1000",
    payTo: canaries(SEED, "evm-test", "evm").get("legit").address,
    maxTimeoutSeconds: 60,
    extra,
  };
}

async function realPayment(reqs: PaymentRequirements): Promise<PaymentPayload> {
  const account = privateKeyToAccount(agentWallet(SEED, "evm").secret as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://provider.test/weather/today" },
    accepts: [reqs],
  };
  return client.createPaymentPayload(required);
}

describe("capture.decodePayload is total (U29-0)", () => {
  it.each([
    ["a non-object", 42, "malformed_network"],
    ["null", null, "malformed_network"],
    ["an array", [], "malformed_network"],
    ["a string (undecodable header)", "not-json", "undecodable_header"],
    ["a v1 payload with no network", { scheme: "exact", payload: {} }, "malformed_network"],
    [
      "a v2 payload whose network is an object",
      { accepted: { network: { a: 1 } }, payload: {} },
      "malformed_network",
    ],
    [
      "a Solana payload with no transaction",
      { accepted: { network: "solana:x", scheme: "exact" }, payload: {} },
      "malformed_payload",
    ],
  ])("records %s as a decode_error leg", async (_label, payload, code) => {
    const leg = await capture.decodePayload(payload);
    expect(leg.valid).toBe(false);
    expect(leg.invalid_reason).toBe("decode_error");
    expect(leg.decode_error).toBe(code);
    expect(leg.amount_atomic).toBe("0");
    expect(leg.dedupe_key).toMatch(/^decode_error:[0-9a-f]{32}$/);
    expect(leg.raw).toEqual(payload);
  });

  it("gives distinct garbage distinct dedupe keys, and the same garbage the same key", async () => {
    const a = await capture.decodePayload({ x: 1 });
    const b = await capture.decodePayload({ x: 2 });
    const a2 = await capture.decodePayload({ x: 1 });
    expect(a.dedupe_key).not.toBe(b.dedupe_key);
    expect(a.dedupe_key).toBe(a2.dedupe_key);
  });

  it("does not throw on a payload that JSON cannot serialise", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const leg = await capture.decodePayload(cyclic);
    expect(leg.decode_error).toBe("malformed_network");
  });

  it("still records a non-digit amount as negative_amount, with the decode_error on the ledger", async () => {
    for (const value of [" 1", "1.5", "0x10", "+5", "1e6", "", "-3"]) {
      const payload = (await realPayment(requirements())) as PaymentPayload & {
        payload: { authorization: { value: string } };
      };
      payload.payload.authorization.value = value;
      const leg = await capture.decodePayload(payload);
      expect(leg.valid).toBe(false);
      expect(leg.invalid_reason).toBe("negative_amount");
      expect(leg.decode_error).toBe("non_digit_amount");
    }
  });
});

describe("offered-terms verification (U29-0)", () => {
  const reqs = requirements();
  const offered = (over: Record<string, unknown> = {}) => ({
    offeredTerms: [
      {
        network: CHAIN_DEFAULTS.evm.network,
        asset: CHAIN_DEFAULTS.evm.asset,
        payTo: reqs.payTo,
        amount: reqs.amount,
        extra: CHAIN_DEFAULTS.evm.extra,
        ...over,
      },
    ],
  });

  it("reports offered when domain, recipient and amount all match the offer", async () => {
    const leg = await capture.decodePayload(await realPayment(reqs), offered());
    expect(leg.valid).toBe(true);
    expect(leg.terms_verified).toBe("offered");
  });

  it("matches the recipient case-insensitively", async () => {
    const leg = await capture.decodePayload(
      await realPayment(reqs),
      offered({ payTo: reqs.payTo.toLowerCase() }),
    );
    expect(leg.terms_verified).toBe("offered");
  });

  it("reports offered_domain_only when the offered recipient differs", async () => {
    const leg = await capture.decodePayload(
      await realPayment(reqs),
      offered({ payTo: "0x00000000000000000000000000000000000000aa" }),
    );
    expect(leg.terms_verified).toBe("offered_domain_only");
  });

  it("reports offered_domain_only when the offered amount differs or is not an integer", async () => {
    for (const amount of ["999", "1000.0", "0x3e8", " 1000", ""]) {
      const leg = await capture.decodePayload(await realPayment(reqs), offered({ amount }));
      expect(leg.terms_verified, amount).toBe("offered_domain_only");
    }
  });

  it("an offered entry without extra.name/version cannot verify as offered (no USDC/2 fallback)", async () => {
    for (const extra of [undefined, {}, { name: "USDC" }, { version: "2" }]) {
      const leg = await capture.decodePayload(await realPayment(reqs), offered({ extra }));
      expect(leg.terms_verified, JSON.stringify(extra)).toBe("client_copy");
    }
  });

  it("reports client_copy when the offered domain does not verify but the client's copy does", async () => {
    const leg = await capture.decodePayload(
      await realPayment(reqs),
      offered({ extra: { name: "Other", version: "9" } }),
    );
    expect(leg.valid).toBe(true);
    expect(leg.terms_verified).toBe("client_copy");
  });

  it("reports the offered reading, but leaves valid alone, when the client echoed different terms", async () => {
    const echoed = structuredClone(await realPayment(reqs)) as PaymentPayload;
    (echoed.accepted as { extra: unknown }).extra = { name: "Fake", version: "1" };
    const leg = await capture.decodePayload(echoed, offered());
    expect(leg.terms_verified).toBe("offered");
    expect(leg.valid).toBe(false);
    expect(leg.invalid_reason).toBe("bad_signature");
  });

  it("reports none when neither reading verifies", async () => {
    const payload = (await realPayment(reqs)) as PaymentPayload & {
      payload: { authorization: { value: string } };
    };
    payload.payload.authorization.value = "1001";
    const leg = await capture.decodePayload(payload, offered());
    expect(leg.terms_verified).toBe("none");
    expect(leg.valid).toBe(false);
  });

  it("reports client_copy without offered terms, as today", async () => {
    const leg = await capture.decodePayload(await realPayment(reqs));
    expect(leg.terms_verified).toBe("client_copy");
  });
});

describe("non-string identity fields are decode errors (U29-0)", () => {
  it.each([5, {}, null, ["x"]])("accepted.asset = %j", async (asset) => {
    const payload = structuredClone(await realPayment(requirements())) as unknown as {
      accepted: { asset: unknown };
    };
    payload.accepted.asset = asset;
    const leg = await capture.decodePayload(payload);
    expect(leg.valid).toBe(false);
    expect(leg.invalid_reason).toBe("decode_error");
    expect(leg.decode_error).toBe("malformed_payload");
    expect(typeof leg.asset).toBe("string");
  });

  it.each(["from", "to"])("authorization.%s that is not a string", async (field) => {
    const payload = structuredClone(await realPayment(requirements())) as unknown as {
      payload: { authorization: Record<string, unknown> };
    };
    (payload.payload.authorization as Record<string, unknown>)[field] = 5;
    const leg = await capture.decodePayload(payload);
    expect(leg.decode_error).toBe("malformed_payload");
  });
});

// A seeded generator (mulberry32), so the property test needs no dependency and replays.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NETWORKS = ["eip155:84532", "solana:x", "base-sepolia", "solana-devnet", "", "eip155:", "x"];
const AMOUNTS = ["1000", " 1", "1.5", "0x10", "+5", "1e6", "", "-3", "9".repeat(80)];

function gen(r: () => number, depth = 0): unknown {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const kind = r();
  if (depth > 3 || kind < 0.35) {
    return pick<unknown>([null, true, 0, -1, 1.5, "", "x", pick(NETWORKS), pick(AMOUNTS), [], {}]);
  }
  if (kind < 0.5) return Array.from({ length: Math.floor(r() * 3) }, () => gen(r, depth + 1));
  const keys = [
    "accepted",
    "payload",
    "network",
    "scheme",
    "asset",
    "extra",
    "authorization",
    "signature",
    "from",
    "to",
    "value",
    "validAfter",
    "validBefore",
    "nonce",
    "transaction",
    "permit2Authorization",
    "permitted",
    "token",
    "amount",
    "extensions",
    "x402Version",
  ];
  const obj: Record<string, unknown> = {};
  for (let i = 0, n = Math.floor(r() * 6); i < n; i++) {
    const k = pick(keys);
    if (k === "network") obj[k] = pick([...NETWORKS, 7, null]);
    else if (k === "value" || k === "amount") obj[k] = pick([...AMOUNTS, 5, null]);
    else obj[k] = gen(r, depth + 1);
  }
  return obj;
}

describe("property: every payload yields a recorded leg and no throw (U29-0)", () => {
  it("holds over 3000 seeded random JSON payloads, with and without offered terms", async () => {
    const r = rng(0x29_0);
    for (let i = 0; i < 3000; i++) {
      const payload = gen(r);
      const hints =
        i % 2 === 0
          ? undefined
          : {
              offeredTerms: [
                { network: CHAIN_DEFAULTS.evm.network, asset: CHAIN_DEFAULTS.evm.asset },
              ],
            };
      const leg = await capture.decodePayload(payload, hints);
      expect(typeof leg.dedupe_key).toBe("string");
      expect(typeof leg.amount_atomic).toBe("string");
      expect(typeof leg.valid).toBe("boolean");
      expect(["evm", "svm"]).toContain(leg.chain);
      if (!leg.valid) expect(leg.invalid_reason).toBeTypeOf("string");
    }
  });

  it("holds over wrapped real-shaped payloads with mutated fields", async () => {
    const base = await realPayment(requirements());
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const p = structuredClone(base) as unknown as {
        accepted: Record<string, unknown>;
        payload: { authorization: Record<string, unknown> };
      };
      const target = r() < 0.5 ? p.accepted : p.payload.authorization;
      const keys = Object.keys(target);
      target[keys[Math.floor(r() * keys.length)] as string] = gen(r, 2);
      const leg = await capture.decodePayload(p);
      expect(typeof leg.valid).toBe("boolean");
    }
  });
});
