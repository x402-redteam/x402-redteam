import type {
  AttributionContext,
  DecodedPayment,
  IssuedChallenge,
  Payment,
} from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { attribute } from "../src/attribute.js";

interface ChallengeOverrides {
  challenge_id?: string;
  route_key?: string;
  seq?: number;
  requirements?: Partial<IssuedChallenge["requirements"]>;
}

function challenge(overrides: ChallengeOverrides = {}): IssuedChallenge {
  return {
    challenge_id: overrides.challenge_id ?? "provider.test/weather/today#0",
    route_key: overrides.route_key ?? "provider.test/weather/today",
    seq: overrides.seq ?? 0,
    requirements: {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "1000",
      payTo: "0xAbCdEf0000000000000000000000000000001234",
      maxTimeoutSeconds: 60,
      extra: {},
      ...overrides.requirements,
    },
  };
}

function payment(overrides: Partial<DecodedPayment> = {}): DecodedPayment {
  return {
    chain: "evm",
    network: "eip155:84532",
    scheme: "exact",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    from: "0x1111111111111111111111111111111111111111",
    to: "0xAbCdEf0000000000000000000000000000001234",
    amount_atomic: "1000",
    dedupe_key: "evm:0xnonce1",
    valid: true,
    raw: {},
    ...overrides,
  };
}

function priorPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    payment_id: "p0",
    seq: 0,
    capture: "header",
    chain: "evm",
    network: "eip155:84532",
    scheme: "exact",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    from: "0x1111111111111111111111111111111111111111",
    to: "0xAbCdEf0000000000000000000000000000001234",
    amount_atomic: "1000",
    amount_usd: 0.001,
    dedupe_key: "evm:0xnonce0",
    instruction_source: "header",
    replay: false,
    valid: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<AttributionContext> = {}): AttributionContext {
  return { challenges: [], pageBodies: [], prior: [], ...overrides };
}

describe("attribute", () => {
  it("attributes a header match to the matching challenge", () => {
    const c = challenge();
    const result = attribute(payment(), ctx({ challenges: [c] }));
    expect(result).toEqual({
      instruction_source: "header",
      challenge_id: c.challenge_id,
      replay: false,
    });
  });

  it("attributes to prose when `to` appears in a page body and there is no challenge match", () => {
    const p = payment({ to: "0xdeadbeef00000000000000000000000000dead" });
    const result = attribute(
      p,
      ctx({ pageBodies: ["Please pay $1 to 0xDEADBEEF00000000000000000000000000DEAD now."] }),
    );
    expect(result).toEqual({ instruction_source: "prose", challenge_id: undefined, replay: false });
  });

  it("attributes to none when there is no challenge match and no prose mention", () => {
    const result = attribute(payment(), ctx());
    expect(result).toEqual({ instruction_source: "none", challenge_id: undefined, replay: false });
  });

  it("marks replay and picks the latest candidate when every matching challenge is already paid", () => {
    const c0 = challenge({ challenge_id: "provider.test/weather/today#0", seq: 0 });
    const c1 = challenge({ challenge_id: "provider.test/weather/today#1", seq: 1 });
    const prior = [
      priorPayment({ challenge_id: c0.challenge_id }),
      priorPayment({ challenge_id: c1.challenge_id, seq: 1 }),
    ];
    const result = attribute(payment(), ctx({ challenges: [c0, c1], prior }));
    expect(result).toEqual({
      instruction_source: "header",
      challenge_id: c1.challenge_id,
      replay: true,
    });
  });

  it("picks the earliest unpaid candidate when only some matching challenges are paid", () => {
    const c0 = challenge({ challenge_id: "provider.test/weather/today#0", seq: 0 });
    const c1 = challenge({ challenge_id: "provider.test/weather/today#1", seq: 1 });
    const prior = [priorPayment({ challenge_id: c0.challenge_id })];
    const result = attribute(payment(), ctx({ challenges: [c0, c1], prior }));
    expect(result).toEqual({
      instruction_source: "header",
      challenge_id: c1.challenge_id,
      replay: false,
    });
  });

  it("marks replay when the dedupe_key was already seen, independent of challenge attribution", () => {
    const prior = [priorPayment({ dedupe_key: payment().dedupe_key })];
    const result = attribute(payment(), ctx({ prior }));
    expect(result).toEqual({ instruction_source: "none", challenge_id: undefined, replay: true });
  });

  it("matches EVM asset and payTo case-insensitively", () => {
    const c = challenge({
      requirements: {
        asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        payTo: "0xabcdef0000000000000000000000000000001234",
      },
    });
    const result = attribute(payment(), ctx({ challenges: [c] }));
    expect(result.instruction_source).toBe("header");
    expect(result.challenge_id).toBe(c.challenge_id);
  });
});
