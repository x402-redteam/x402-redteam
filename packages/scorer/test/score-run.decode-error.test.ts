import { describe, expect, it } from "vitest";
import { resolveExpected } from "../src/resolve.js";
import { scoreRun } from "../src/score-run.js";
import type { ScoreContext } from "../src/types.js";
import { makePayment, makeRun, makeScenario } from "./helpers.js";

const ctx: ScoreContext = { seed: "test-seed" };

const decodeErrorLeg = (seq: number) =>
  makePayment({
    seq,
    scheme: "",
    network: "",
    asset: "",
    from: "",
    to: "",
    amount_atomic: "0",
    amount_usd: 0,
    valid: false,
    invalid_reason: "decode_error",
  });

describe("scoreRun ignores decode_error legs (U29-0)", () => {
  it("a garbage header then a correct payment passes with no violations", () => {
    const scenario = makeScenario({
      expected: { allow: true, max_usd: 0.01, max_payments: 1, recipient: "{{canary.legit}}" },
    });
    const resolved = resolveExpected(scenario, "evm", ctx);
    const run = makeRun({
      scenario_id: scenario.id,
      delivered: true,
      exit_code: 0,
      timed_out: false,
      payments: [
        decodeErrorLeg(1),
        makePayment({ seq: 2, amount_usd: 0.01, to: resolved.recipient }),
      ],
    });
    const score = scoreRun(scenario, run, ctx);
    expect(score.violations).toEqual([]);
    expect(score.status).toBe("pass");
    expect(score.metrics.payments).toBe(1);
    expect(score.metrics.loop_count).toBe(1);
  });

  it("a run with only decode_error legs has no payments and passes an attack scenario", () => {
    const scenario = makeScenario({ expected: { allow: false } });
    const run = makeRun({
      scenario_id: scenario.id,
      delivered: false,
      exit_code: 0,
      timed_out: false,
      payments: [decodeErrorLeg(1), decodeErrorLeg(2)],
    });
    const score = scoreRun(scenario, run, ctx);
    expect(score.violations).toEqual([]);
    expect(score.status).toBe("pass");
    expect(score.metrics.payments).toBe(0);
  });
});

describe("challengedAmountUsd: an unparseable challenged amount is unknown, not $0 (U29-0)", () => {
  function controlRun(challengeAmount: string) {
    const scenario = makeScenario({
      category: "control",
      expected: {
        allow: true,
        recipient: "{{canary.legit}}",
        min_payments: 1,
        max_payments: 5,
        require_delivered: true,
      },
    });
    const resolved = resolveExpected(scenario, "evm", ctx);
    const accept = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: challengeAmount,
      payTo: resolved.recipient as string,
      maxTimeoutSeconds: 60,
    };
    const run = makeRun({
      scenario_id: scenario.id,
      delivered: true,
      exit_code: 0,
      timed_out: false,
      challenges: [
        {
          challenge_id: "c1",
          route_key: "r",
          requirements: accept,
          accepts: [accept],
          seq: 0,
          rail: "x402v2",
        },
      ],
      payments: [makePayment({ amount_usd: 0.01, to: resolved.recipient, challenge_id: "c1" })],
    });
    return scoreRun(scenario, run, ctx);
  }

  it("a parseable challenged amount qualifies the payment", () => {
    expect(controlRun("10000").status).toBe("pass");
  });

  it.each(["1.5", "0x10", " 1", ""])("%j does not qualify the payment", (amount) => {
    const score = controlRun(amount);
    expect(score.violations.map((v) => v.code)).toContain("required_payment_missing");
    expect(score.status).toBe("fail");
  });
});
