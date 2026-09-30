import { describe, expect, it } from "vitest";
import { assetKnown, type Payment, PaymentSchema, RunRecordSchema } from "../src/ledger.js";

describe("RunRecordSchema", () => {
  it("accepts a hand-written RunRecord fixture", () => {
    const fixture = {
      run_id: "ghost-paywall-basic:evm:1",
      scenario_id: "ghost-paywall-basic",
      chain: "evm",
      attempt: 1,
      agent_id: "naive",
      guardrail_id: "none",
      requests: [
        {
          seq: 0,
          method: "GET",
          host: "provider.test",
          path: "/weather/today",
          status: 402,
          paid: false,
        },
        {
          seq: 1,
          method: "GET",
          host: "provider.test",
          path: "/weather/today",
          status: 200,
          paid: true,
        },
      ],
      challenges: [
        {
          challenge_id: "provider.test/weather/today#0",
          route_key: "provider.test/weather/today",
          requirements: {
            scheme: "exact",
            network: "eip155:84532",
            maxAmountRequired: "10000",
            resource: "http://127.0.0.1:4000/weather/today",
            description: "weather forecast",
            mimeType: "text/markdown",
            payTo: "0x2C25df290d6a3871C9bF22d76AD6De15c9f4Eebc",
            maxTimeoutSeconds: 60,
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
          // v2 (application-design.md §4 "v2"): required, every entry that went on the
          // wire, in order. `requirements` (kept, = accepts[0]) is a single-option v1
          // challenge here, so the list has one element.
          accepts: [
            {
              scheme: "exact",
              network: "eip155:84532",
              maxAmountRequired: "10000",
              resource: "http://127.0.0.1:4000/weather/today",
              description: "weather forecast",
              mimeType: "text/markdown",
              payTo: "0x2C25df290d6a3871C9bF22d76AD6De15c9f4Eebc",
              maxTimeoutSeconds: 60,
              asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            },
          ],
          seq: 0,
        },
      ],
      payments: [
        {
          payment_id: "p0",
          seq: 1,
          capture: "header",
          chain: "evm",
          network: "eip155:84532",
          scheme: "exact",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2C25df290d6a3871C9bF22d76AD6De15c9f4Eebc",
          amount_atomic: "10000",
          amount_usd: 0.01,
          route_key: "provider.test/weather/today",
          host: "provider.test",
          dedupe_key: "0xnonce123",
          instruction_source: "header",
          challenge_id: "provider.test/weather/today#0",
          replay: false,
          valid: true,
          raw: { note: "decoded payload for audit" },
        },
      ],
      delivered: true,
      exit_code: 0,
      timed_out: false,
      timing: { duration_ms: 842 },
    };

    const result = RunRecordSchema.parse(fixture);
    expect(result.run_id).toBe(fixture.run_id);
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]?.capture).toBe("header");
  });

  it("accepts capture 'header+shim' and a null exit_code", () => {
    const result = RunRecordSchema.parse({
      run_id: "x:evm:1",
      scenario_id: "x",
      chain: "evm",
      attempt: 1,
      agent_id: "a",
      guardrail_id: "g",
      requests: [],
      challenges: [],
      payments: [
        {
          payment_id: "p0",
          seq: 0,
          capture: "header+shim",
          chain: "evm",
          network: "eip155:84532",
          scheme: "exact",
          asset: "0xasset",
          from: "0xfrom",
          to: "0xto",
          amount_atomic: "1",
          amount_usd: 0.000001,
          dedupe_key: "d",
          instruction_source: "none",
          replay: true,
          valid: false,
        },
      ],
      delivered: false,
      exit_code: null,
      timed_out: true,
      timing: { duration_ms: 60000 },
    });

    expect(result.exit_code).toBeNull();
    expect(result.payments[0]?.capture).toBe("header+shim");
  });

  // v2 (Bolt 5, U9 Part A functional-design.md §A1).
  it("accepts capture 'rpc' and 'rpc+shim', and the optional asset_known/authorization_seconds fields", () => {
    const basePayment = {
      payment_id: "p0",
      seq: 0,
      chain: "evm" as const,
      network: "eip155:84532",
      scheme: "exact",
      asset: "0xasset",
      from: "0xfrom",
      to: "0xto",
      amount_atomic: "1",
      amount_usd: 0.000001,
      dedupe_key: "d",
      instruction_source: "none" as const,
      replay: false,
      valid: true,
    };

    for (const capture of ["rpc", "rpc+shim"] as const) {
      const result = RunRecordSchema.parse({
        run_id: "x:evm:1",
        scenario_id: "x",
        chain: "evm",
        attempt: 1,
        agent_id: "a",
        guardrail_id: "g",
        requests: [],
        challenges: [],
        payments: [{ ...basePayment, capture, asset_known: false, authorization_seconds: 120 }],
        delivered: false,
        exit_code: 0,
        timed_out: false,
        timing: { duration_ms: 1 },
      });
      expect(result.payments[0]?.capture).toBe(capture);
      expect(result.payments[0]?.asset_known).toBe(false);
      expect(result.payments[0]?.authorization_seconds).toBe(120);
    }
  });

  it("leaves asset_known and authorization_seconds absent when not provided (no schema default)", () => {
    const result = RunRecordSchema.parse({
      run_id: "x:evm:1",
      scenario_id: "x",
      chain: "evm",
      attempt: 1,
      agent_id: "a",
      guardrail_id: "g",
      requests: [],
      challenges: [],
      payments: [
        {
          payment_id: "p0",
          seq: 0,
          capture: "header",
          chain: "evm",
          network: "eip155:84532",
          scheme: "exact",
          asset: "0xasset",
          from: "0xfrom",
          to: "0xto",
          amount_atomic: "1",
          amount_usd: 0.000001,
          dedupe_key: "d",
          instruction_source: "none",
          replay: false,
          valid: true,
        },
      ],
      delivered: false,
      exit_code: 0,
      timed_out: false,
      timing: { duration_ms: 1 },
    });
    expect(result.payments[0]?.asset_known).toBeUndefined();
    expect(result.payments[0]?.authorization_seconds).toBeUndefined();
  });

  it("requires IssuedChallenge.accepts", () => {
    expect(() =>
      RunRecordSchema.parse({
        run_id: "x:evm:1",
        scenario_id: "x",
        chain: "evm",
        attempt: 1,
        agent_id: "a",
        guardrail_id: "g",
        requests: [],
        challenges: [
          {
            challenge_id: "c#0",
            route_key: "provider.test/x",
            requirements: { scheme: "exact" },
            seq: 0,
            // accepts intentionally omitted
          },
        ],
        payments: [],
        delivered: false,
        exit_code: 0,
        timed_out: false,
        timing: { duration_ms: 1 },
      }),
    ).toThrow();
  });
});

// Code review L3 / L4.
describe("Payment.authorization_seconds / assetKnown (v2)", () => {
  const basePayment = {
    payment_id: "p0",
    seq: 0,
    capture: "header" as const,
    chain: "evm" as const,
    network: "eip155:84532",
    scheme: "exact",
    asset: "0xasset",
    from: "0xfrom",
    to: "0xto",
    amount_atomic: "1",
    amount_usd: 0.000001,
    dedupe_key: "d",
    instruction_source: "none" as const,
    replay: false,
    valid: true,
  };

  it("accepts a negative authorization_seconds (a negative window is signal, not invalid shape)", () => {
    const result = PaymentSchema.parse({ ...basePayment, authorization_seconds: -30 });
    expect(result.authorization_seconds).toBe(-30);
  });

  it("assetKnown() defaults to true when asset_known is absent", () => {
    const payment: Payment = { ...basePayment };
    expect(assetKnown(payment)).toBe(true);
  });

  it("assetKnown() returns the declared value when set", () => {
    const payment: Payment = { ...basePayment, asset_known: false };
    expect(assetKnown(payment)).toBe(false);
  });
});
