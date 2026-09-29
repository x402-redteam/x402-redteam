import { CHAIN_DEFAULTS, canaries } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { resolveExpected } from "../src/resolve.js";
import type { ScoreContext } from "../src/types.js";
import { makeScenario } from "./helpers.js";

const ctx: ScoreContext = { seed: "test-seed" };

describe("resolveExpected", () => {
  it("leaves recipient undefined when expected.recipient is unset", () => {
    const scenario = makeScenario({ expected: { allow: false } });
    const resolved = resolveExpected(scenario, "evm", ctx);
    expect(resolved.recipient).toBeUndefined();
  });

  it("renders expected.recipient using canaries(seed, scenario.id, chain)", () => {
    const scenario = makeScenario({
      id: "recipient-render",
      expected: { allow: true, max_usd: 0.05, recipient: "{{canary.legit}}" },
    });
    const resolved = resolveExpected(scenario, "evm", ctx);
    const expectedAddress = canaries(ctx.seed, "recipient-render", "evm").get("legit").address;
    expect(resolved.recipient).toBe(expectedAddress);
  });

  it("is a pure function of (scenario, chain, ctx): same inputs render the same recipient", () => {
    const scenario = makeScenario({
      id: "recipient-pure",
      expected: { allow: true, max_usd: 0.05, recipient: "{{canary.legit}}" },
    });
    const a = resolveExpected(scenario, "evm", ctx);
    const b = resolveExpected(scenario, "evm", ctx);
    expect(a.recipient).toBe(b.recipient);
  });

  it("renders a different address per chain", () => {
    const scenario = makeScenario({
      id: "recipient-per-chain",
      chains: ["evm", "svm"],
      expected: { allow: true, max_usd: 0.05, recipient: "{{canary.legit}}" },
    });
    const evm = resolveExpected(scenario, "evm", ctx);
    const svm = resolveExpected(scenario, "svm", ctx);
    expect(evm.recipient).not.toBe(svm.recipient);
  });

  it("defaults networks to the chain's default test network", () => {
    const scenario = makeScenario({ expected: { allow: false } });
    expect(resolveExpected(scenario, "evm", ctx).networks).toEqual([CHAIN_DEFAULTS.evm.network]);
    expect(resolveExpected(scenario, "svm", ctx).networks).toEqual([CHAIN_DEFAULTS.svm.network]);
  });

  it("passes through explicit networks", () => {
    const scenario = makeScenario({ expected: { allow: false, networks: ["eip155:1"] } });
    expect(resolveExpected(scenario, "evm", ctx).networks).toEqual(["eip155:1"]);
  });

  it("defaults max_payments to 1 when allow is true, 0 when allow is false", () => {
    const allowed = makeScenario({ expected: { allow: true, max_usd: 0.05 } });
    const disallowed = makeScenario({ expected: { allow: false } });
    expect(resolveExpected(allowed, "evm", ctx).max_payments).toBe(1);
    expect(resolveExpected(disallowed, "evm", ctx).max_payments).toBe(0);
  });

  it("lifts allowed_hosts from scenario.task", () => {
    const scenario = makeScenario({
      task: { prompt: "x", allowed_hosts: ["provider.test", "cdn.test"] },
      expected: { allow: false },
    });
    expect(resolveExpected(scenario, "evm", ctx).allowed_hosts).toEqual([
      "provider.test",
      "cdn.test",
    ]);
  });

  it("leaves allowed_hosts undefined when the task doesn't declare any", () => {
    const scenario = makeScenario({ expected: { allow: false } });
    expect(resolveExpected(scenario, "evm", ctx).allowed_hosts).toBeUndefined();
  });
});
