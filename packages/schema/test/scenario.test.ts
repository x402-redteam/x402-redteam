import { describe, expect, it } from "vitest";
import {
  acceptsForChain,
  CategorySchema,
  ChallengeSpecSchema,
  challengeForChain,
  ExpectedSchema,
  minPayments,
  requireDelivered,
  ScenarioSchema,
  TaskSchema,
  walletBalanceUsd,
} from "../src/scenario.js";

describe("ScenarioSchema", () => {
  it("parses a valid minimal scenario and applies defaults", () => {
    const result = ScenarioSchema.parse({
      id: "minimal",
      title: "Minimal",
      category: "ghost_paywall",
      severity: "low",
      description: "A minimal scenario.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x" }],
      expected: { allow: false },
    });

    expect(result.chains).toEqual(["evm", "svm"]);
    expect(result.routes[0]?.method).toBe("GET");
    expect(result.routes[0]?.behaviour).toBe("normal");
    expect(result.routes[0]?.host).toBe("provider.test");
    expect(result.routes[0]?.content_type).toBe("text/markdown");
    expect(result.expected.max_payments).toBe(0);
  });

  it("defaults max_payments to 1 when expected.allow is true", () => {
    const result = ScenarioSchema.parse({
      id: "minimal-allow",
      title: "Minimal allow",
      category: "ghost_paywall",
      severity: "low",
      description: "A minimal scenario that allows payment.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x" }],
      expected: { allow: true, max_usd: 0.05 },
    });

    expect(result.expected.max_payments).toBe(1);
  });

  it("applies challenge defaults", () => {
    const result = ScenarioSchema.parse({
      id: "challenge-defaults",
      title: "Challenge defaults",
      category: "ghost_paywall",
      severity: "low",
      description: "Checks ChallengeSpec defaults.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x", challenge: { pay_to: "0xabc" } }],
      expected: { allow: false },
    });

    expect(result.routes[0]?.challenge?.scheme).toBe("exact");
    expect(result.routes[0]?.challenge?.max_timeout_seconds).toBe(60);
  });

  it("rejects an invalid category", () => {
    expect(() =>
      ScenarioSchema.parse({
        id: "bad",
        title: "Bad",
        category: "not_a_real_category",
        severity: "low",
        description: "x",
        task: { prompt: "x" },
        routes: [{ path: "/x" }],
        expected: { allow: false },
      }),
    ).toThrow();
  });
});

describe("challengeForChain", () => {
  it("applies per_chain overrides and merges extra", () => {
    const spec = ChallengeSpecSchema.parse({
      amount_usd: 0.01,
      pay_to: "{{canary.legit}}",
      extra: { a: 1 },
      per_chain: { evm: { network: "eip155:8453", extra: { b: 2 } } },
    });
    const evm = challengeForChain(spec, "evm");
    expect(evm.network).toBe("eip155:8453");
    expect(evm.extra).toEqual({ a: 1, b: 2 });
    expect("per_chain" in evm).toBe(false);
    expect(challengeForChain(spec, "svm").network).toBeUndefined();
  });
});

// v2 (Bolt 5, U9 Part A functional-design.md §A1).
describe("CategorySchema (v2)", () => {
  it("still accepts every v1 category", () => {
    for (const category of [
      "ghost_paywall",
      "prose_payment",
      "recipient_redirect",
      "price_bait",
      "retry_storm",
      "fake_delivery",
      "replay",
      "unit_confusion",
      "lookalike_domain",
      "rail_switch",
    ]) {
      expect(CategorySchema.parse(category)).toBe(category);
    }
  });

  it("accepts every new v2 category", () => {
    for (const category of [
      "control",
      "resource_spoof",
      "authorization_lifetime",
      "asset_swap",
      "budget_split",
      "challenge_injection",
      "accepts_ordering",
    ]) {
      expect(CategorySchema.parse(category)).toBe(category);
    }
  });
});

describe("ChallengeSpecSchema (v2 pay_to/accepts refine)", () => {
  it("accepts a v1-style spec with only pay_to", () => {
    expect(() => ChallengeSpecSchema.parse({ amount_usd: 0.01, pay_to: "0xabc" })).not.toThrow();
  });

  it("accepts a v2 spec with only accepts", () => {
    expect(() =>
      ChallengeSpecSchema.parse({
        accepts: [{ amount_usd: 0.01, pay_to: "0xabc" }],
      }),
    ).not.toThrow();
  });

  it("rejects a spec with neither pay_to nor accepts", () => {
    expect(() => ChallengeSpecSchema.parse({ amount_usd: 0.01 })).toThrow();
  });

  it("rejects a spec with both pay_to and accepts", () => {
    expect(() =>
      ChallengeSpecSchema.parse({
        pay_to: "0xabc",
        accepts: [{ amount_usd: 0.01, pay_to: "0xdef" }],
      }),
    ).toThrow();
  });

  // Code review L1: once `accepts` replaces the single-option fields, those fields must
  // not also be set - each accepts[] entry carries its own amount/network/asset/extra/
  // per_chain instead.
  it.each([
    ["amount_usd", { amount_usd: 0.01 }],
    ["amount_atomic", { amount_atomic: "10000" }],
    ["network", { network: "eip155:8453" }],
    ["asset", { asset: "0xasset" }],
    ["extra", { extra: { a: 1 } }],
    ["per_chain", { per_chain: { evm: { pay_to: "0xoverride" } } }],
  ] as const)("rejects %s set alongside accepts, with a clear message", (field, extraFields) => {
    const result = ChallengeSpecSchema.safeParse({
      accepts: [{ amount_usd: 0.01, pay_to: "0xabc" }],
      ...extraFields,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === field);
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(new RegExp(`${field}.*must not be set.*accepts`));
    }
  });

  it("accepts the single-option fields when only pay_to is set (no accepts)", () => {
    expect(() =>
      ChallengeSpecSchema.parse({
        pay_to: "0xabc",
        amount_usd: 0.01,
        network: "eip155:84532",
        asset: "0xasset",
        extra: { a: 1 },
        per_chain: { evm: { pay_to: "0xoverride" } },
      }),
    ).not.toThrow();
  });

  it("applies AcceptSpec defaults (scheme, max_timeout_seconds)", () => {
    const spec = ChallengeSpecSchema.parse({
      accepts: [{ amount_usd: 0.01, pay_to: "0xabc" }],
    });
    expect(spec.accepts?.[0]?.scheme).toBe("exact");
    expect(spec.accepts?.[0]?.max_timeout_seconds).toBe(60);
  });

  it("accepts resource_url and body_json", () => {
    const spec = ChallengeSpecSchema.parse({
      pay_to: "0xabc",
      resource_url: "{{base_url}}/spoofed",
      body_json: { error: "payment_required", nested: { note: "hi" } },
    });
    expect(spec.resource_url).toBe("{{base_url}}/spoofed");
    expect(spec.body_json).toEqual({ error: "payment_required", nested: { note: "hi" } });
  });
});

describe("acceptsForChain (v2)", () => {
  it("resolves a v1 single-option spec to a one-element list", () => {
    const spec = ChallengeSpecSchema.parse({ amount_usd: 0.01, pay_to: "{{canary.legit}}" });
    const resolved = acceptsForChain(spec, "evm");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      amount_usd: 0.01,
      pay_to: "{{canary.legit}}",
      scheme: "exact",
      max_timeout_seconds: 60,
    });
  });

  it("resolves an ordered accepts[] list, applying per-entry per_chain overrides", () => {
    const spec = ChallengeSpecSchema.parse({
      accepts: [
        { amount_usd: 0.01, pay_to: "mainnet-rail" },
        {
          amount_usd: 0.01,
          pay_to: "test-rail",
          per_chain: { evm: { network: "eip155:84532" } },
        },
      ],
    });
    const resolved = acceptsForChain(spec, "evm");
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.pay_to).toBe("mainnet-rail");
    expect(resolved[1]?.network).toBe("eip155:84532");
  });

  // Code review M1: the v1 path must omit absent keys (no explicit `key: undefined`),
  // matching challengeForChain's own contract, so a resolved entry serializes/compares
  // the same way a hand-written AcceptSpec with those fields never set would.
  it("v1 path: omits keys the spec never set, rather than setting them to undefined", () => {
    const spec = ChallengeSpecSchema.parse({ pay_to: "{{canary.legit}}" });
    const resolved = acceptsForChain(spec, "evm");
    expect(resolved).toStrictEqual([
      { pay_to: "{{canary.legit}}", scheme: "exact", max_timeout_seconds: 60 },
    ]);
    expect(Object.keys(resolved[0] as object).sort()).toEqual(
      ["max_timeout_seconds", "pay_to", "scheme"].sort(),
    );
  });

  it("accepts[] path: omits keys an entry never set, rather than setting them to undefined", () => {
    const spec = ChallengeSpecSchema.parse({
      accepts: [{ pay_to: "{{canary.legit}}" }],
    });
    const resolved = acceptsForChain(spec, "evm");
    expect(resolved).toStrictEqual([
      { pay_to: "{{canary.legit}}", scheme: "exact", max_timeout_seconds: 60 },
    ]);
    expect(Object.keys(resolved[0] as object).sort()).toEqual(
      ["max_timeout_seconds", "pay_to", "scheme"].sort(),
    );
  });
});

describe("Task.wallet_balance_usd (v2)", () => {
  it("is absent by default and walletBalanceUsd() falls back to 100", () => {
    const task = TaskSchema.parse({ prompt: "do the thing" });
    expect(task.wallet_balance_usd).toBeUndefined();
    expect(walletBalanceUsd(task)).toBe(100);
  });

  it("walletBalanceUsd() returns the declared value when set", () => {
    const task = TaskSchema.parse({ prompt: "do the thing", wallet_balance_usd: 250 });
    expect(walletBalanceUsd(task)).toBe(250);
  });
});

describe("Expected.min_payments / require_delivered / max_authorization_seconds (v2)", () => {
  it("default to 0 / false / undefined via the helpers when absent", () => {
    const expected = ExpectedSchema.parse({ allow: false });
    expect(expected.min_payments).toBeUndefined();
    expect(expected.require_delivered).toBeUndefined();
    expect(expected.max_authorization_seconds).toBeUndefined();
    expect(minPayments(expected)).toBe(0);
    expect(requireDelivered(expected)).toBe(false);
  });

  it("the helpers return the declared values when set", () => {
    const expected = ExpectedSchema.parse({
      allow: true,
      max_usd: 0.01,
      min_payments: 1,
      require_delivered: true,
      max_authorization_seconds: 300,
    });
    expect(minPayments(expected)).toBe(1);
    expect(requireDelivered(expected)).toBe(true);
    expect(expected.max_authorization_seconds).toBe(300);
  });
});

describe("Scenario.assets (v2 asset_swap)", () => {
  it("parses a scenario-declared asset", () => {
    const result = ScenarioSchema.parse({
      id: "with-assets",
      title: "With assets",
      category: "asset_swap",
      severity: "high",
      description: "Declares a scenario-local asset.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x", challenge: { amount_atomic: "10000000", pay_to: "0xabc" } }],
      expected: { allow: false },
      assets: [{ chain: "evm", address: "0xWETH", symbol: "WETH", decimals: 18, usd_price: 3000 }],
    });
    expect(result.assets).toEqual([
      { chain: "evm", address: "0xWETH", symbol: "WETH", decimals: 18, usd_price: 3000 },
    ]);
  });

  it("is absent by default", () => {
    const result = ScenarioSchema.parse({
      id: "no-assets",
      title: "No assets",
      category: "ghost_paywall",
      severity: "low",
      description: "x",
      task: { prompt: "x" },
      routes: [{ path: "/x" }],
      expected: { allow: false },
    });
    expect(result.assets).toBeUndefined();
  });
});
