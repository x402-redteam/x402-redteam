import type {
  AttributionContext,
  DecodedPayment,
  IssuedChallenge,
  Payment,
} from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { attribute } from "../src/attribute.js";
import { merge } from "../src/merge.js";

interface ChallengeOverrides {
  challenge_id?: string;
  route_key?: string;
  seq?: number;
  requirements?: Partial<IssuedChallenge["requirements"]>;
  /** v2 (accepts_ordering): overrides the full accepts[] list directly, e.g. to place
   * the matching entry somewhere other than index 0. When unset, defaults to a
   * 1-element list containing `requirements` (the v1-equivalent shape). */
  accepts?: IssuedChallenge["requirements"][];
}

function challenge(overrides: ChallengeOverrides = {}): IssuedChallenge {
  const requirements: IssuedChallenge["requirements"] = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "1000",
    payTo: "0xAbCdEf0000000000000000000000000000001234",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides.requirements,
  };
  return {
    challenge_id: overrides.challenge_id ?? "provider.test/weather/today#0",
    route_key: overrides.route_key ?? "provider.test/weather/today",
    seq: overrides.seq ?? 0,
    requirements,
    // v2 (application-design.md §4 "v2"): IssuedChallenge.accepts is now required.
    // A 1-element list matching `requirements` is the correct v1-equivalent shape
    // unless the test overrides it directly (accepts_ordering).
    accepts: overrides.accepts ?? [requirements],
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

  it("does not flag replay against its own prior shim-only capture (header+shim dual capture)", () => {
    // A wrapped signer reports the shim event before the header ever reaches the server, so
    // by the time the header-path capture of the *same* payment is attributed, `ctx.prior`
    // already holds a "shim"-only twin sharing this dedupe_key. merge() is about to combine
    // them into one "header+shim" entry - this must not look like the payment is replaying
    // (or already claiming a challenge against) itself.
    const c = challenge();
    const p = payment({ dedupe_key: "evm:0xshared" });
    const shimTwin = priorPayment({
      capture: "shim",
      dedupe_key: "evm:0xshared",
      challenge_id: c.challenge_id,
    });
    const result = attribute(p, ctx({ challenges: [c], prior: [shimTwin] }));
    expect(result).toEqual({
      instruction_source: "header",
      challenge_id: c.challenge_id,
      replay: false,
    });
  });

  it("still flags replay when a fully-captured prior payment (not shim-only) shares the dedupe_key", () => {
    const prior = [priorPayment({ capture: "header+shim", dedupe_key: payment().dedupe_key })];
    const result = attribute(payment(), ctx({ prior }));
    expect(result).toEqual({ instruction_source: "none", challenge_id: undefined, replay: true });
  });

  // U10 re-review: the replay flag was order-dependent - an rpc-layer twin (not just a
  // shim-layer one) must also be excluded from `prior`, whichever order the two layers
  // arrive in, or the merged "header+rpc" payment wrongly reports replay: true.
  it("does not flag replay against its own prior rpc-only capture, rpc arriving before header", () => {
    const c = challenge();
    const p = payment({ dedupe_key: "evm:0xrpcfirst" });
    const rpcTwin = priorPayment({
      capture: "rpc",
      dedupe_key: "evm:0xrpcfirst",
      challenge_id: c.challenge_id,
    });
    const result = attribute(p, ctx({ challenges: [c], prior: [rpcTwin] }));
    expect(result).toEqual({
      instruction_source: "header",
      challenge_id: c.challenge_id,
      replay: false,
    });
  });

  /**
   * Mirrors the rpc-first case above with the layers reversed, but at the *merged*
   * result rather than a single attribute() call: for header-then-rpc, `attribute()`'s
   * own raw result for the second (rpc) call can still say `replay: true` in isolation
   * (it doesn't know its own capture layer, so it can't tell "my own twin, different
   * layer" apart from "a genuine same-layer duplicate" purely from `prior`) - what
   * matters is that `merge()` (capture/src/merge.ts) always lets the `header`-layer
   * side win ("header" outranks "rpc"/"shim", `LAYER_RANK`), and the header side's own
   * `replay` was correctly computed as `false` back when *it* was attributed (prior was
   * empty). So the final, merged payment - the one that actually reaches report.json -
   * is `replay: false` either way. This simulates the real record-then-merge pipeline
   * (attribute -> build a Payment -> merge) for both single steps, the same shape
   * `record.ts`'s `recordDecoded` uses.
   */
  it("the final merged payment is replay:false for header-then-rpc, even though rpc's own attribute() call can't tell twin from duplicate", () => {
    const c = challenge();
    const dedupe_key = "evm:0xheaderfirst";

    function recordAndMerge(existing: Payment[], capture: Payment["capture"]): Payment[] {
      const decoded = payment({ dedupe_key });
      const attribution = attribute(decoded, ctx({ challenges: [c], prior: existing }));
      const incoming: Payment = {
        ...priorPayment({ dedupe_key, capture }),
        ...attribution,
      };
      return merge(existing, incoming);
    }

    let payments: Payment[] = [];
    payments = recordAndMerge(payments, "header"); // arrives first
    payments = recordAndMerge(payments, "rpc"); // arrives second, same dedupe_key

    expect(payments).toHaveLength(1);
    expect(payments[0]?.capture).toBe("header+rpc");
    expect(payments[0]?.replay).toBe(false);
    expect(payments[0]?.challenge_id).toBe(c.challenge_id);
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

  // U11 (accepts_ordering, application-design.md §4 "v2"): a payment matches a
  // challenge via *any* accepts[] entry, not just accepts[0] (`requirements`).
  it("attributes a header match against accepts[1] when accepts[0] doesn't match", () => {
    const mainnetOption: IssuedChallenge["requirements"] = {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
      payTo: "0xAbCdEf0000000000000000000000000000001234",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const testnetOption: IssuedChallenge["requirements"] = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "1000",
      payTo: "0xAbCdEf0000000000000000000000000000001234",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const c = challenge({ accepts: [mainnetOption, testnetOption] });
    // `payment()`'s default network/asset match `testnetOption` (accepts[1]), not
    // `mainnetOption` (accepts[0]).
    const result = attribute(payment(), ctx({ challenges: [c] }));
    expect(result).toEqual({
      instruction_source: "header",
      challenge_id: c.challenge_id,
      replay: false,
    });
  });

  // Review 1, m2: base58 svm addresses are case-sensitive, so the prose match must be
  // exact on svm, unlike evm's case-insensitive checksum/lowercase match.
  it("matches svm prose exactly (case-sensitive), unlike evm's case-insensitive match", () => {
    const svmPayment = payment({
      chain: "svm",
      to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    const lowerCasedInBody = "9xqewvg816bux9epjhmat23yvvm2zwbrrpzb9pusvfin";

    const noMatch = attribute(svmPayment, ctx({ pageBodies: [`pay $1 to ${lowerCasedInBody}`] }));
    expect(noMatch.instruction_source).toBe("none");

    const exactMatch = attribute(
      svmPayment,
      ctx({ pageBodies: ["pay $1 to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] }),
    );
    expect(exactMatch.instruction_source).toBe("prose");
  });
  describe("payment made after earlier unpaid requests", () => {
    const c1 = challenge({ challenge_id: "provider.test/api/report#1", seq: 1 });
    const c2 = challenge({ challenge_id: "provider.test/api/report#2", seq: 2 });

    it("binds to the unpaid challenge of the current issuance for its route", () => {
      const result = attribute(
        payment(),
        ctx({ challenges: [c1, c2], current_challenge_ids: [c2.challenge_id] }),
      );
      expect(result).toEqual({
        instruction_source: "header",
        challenge_id: c2.challenge_id,
        replay: false,
      });
    });

    it("binds a resubmitted credential to the current challenge and marks it a replay", () => {
      // The same signed credential was already captured once (same dedupe_key) and
      // credited to c1; resubmitting it against a fresh issuance is still a replay.
      const prior = [priorPayment({ challenge_id: c1.challenge_id, dedupe_key: "evm:0xnonce1" })];
      const result = attribute(
        payment({ dedupe_key: "evm:0xnonce1" }),
        ctx({ challenges: [c1, c2], prior, current_challenge_ids: [c2.challenge_id] }),
      );
      expect(result).toEqual({
        instruction_source: "header",
        challenge_id: c2.challenge_id,
        replay: true,
      });
    });

    it("binds to the earliest unpaid match when no current issuance is given", () => {
      const result = attribute(payment(), ctx({ challenges: [c1, c2] }));
      expect(result).toEqual({
        instruction_source: "header",
        challenge_id: c1.challenge_id,
        replay: false,
      });
    });

    it("falls back to the earliest unpaid match when the current challenge is already paid", () => {
      const prior = [priorPayment({ challenge_id: c2.challenge_id })];
      const result = attribute(
        payment(),
        ctx({ challenges: [c1, c2], prior, current_challenge_ids: [c2.challenge_id] }),
      );
      expect(result).toEqual({
        instruction_source: "header",
        challenge_id: c1.challenge_id,
        replay: false,
      });
    });

    it("binds to the latest match as a replay when every match is paid", () => {
      const prior = [
        priorPayment({ challenge_id: c1.challenge_id }),
        priorPayment({ challenge_id: c2.challenge_id, seq: 1, dedupe_key: "evm:0xother" }),
      ];
      const result = attribute(
        payment(),
        ctx({ challenges: [c1, c2], prior, current_challenge_ids: [c1.challenge_id] }),
      );
      expect(result).toEqual({
        instruction_source: "header",
        challenge_id: c2.challenge_id,
        replay: true,
      });
    });

    it("ignores a current challenge that the payment does not match", () => {
      const other = challenge({
        challenge_id: "provider.test/other#1",
        route_key: "provider.test/other",
        seq: 3,
        requirements: { amount: "2000" },
      });
      const result = attribute(
        payment(),
        ctx({ challenges: [c1, c2, other], current_challenge_ids: [other.challenge_id] }),
      );
      expect(result.challenge_id).toBe(c1.challenge_id);
      expect(result.replay).toBe(false);
    });

    it("binds identical challenges on different routes to the route that was paid", () => {
      const stations = [1, 2, 3].map((n) =>
        challenge({
          challenge_id: `provider.test/stations/${n}#1`,
          route_key: `provider.test/stations/${n}`,
          seq: n,
        }),
      );
      const result = attribute(
        payment(),
        ctx({ challenges: stations, current_challenge_ids: ["provider.test/stations/3#1"] }),
      );
      expect(result.challenge_id).toBe("provider.test/stations/3#1");
      expect(result.replay).toBe(false);
    });

    it("a shim capture first, then the header capture: the merged entry keeps the header's challenge", () => {
      const dedupe_key = "evm:0xshimfirst";
      const decoded = payment({ dedupe_key });
      let payments: Payment[] = [];

      const shimAttr = attribute(decoded, ctx({ challenges: [c1, c2], prior: payments }));
      expect(shimAttr.challenge_id).toBe(c1.challenge_id);
      payments = merge(payments, {
        ...priorPayment({ dedupe_key, capture: "shim", seq: 5 }),
        ...shimAttr,
      });

      const headerAttr = attribute(
        decoded,
        ctx({ challenges: [c1, c2], prior: payments, current_challenge_ids: [c2.challenge_id] }),
      );
      expect(headerAttr).toEqual({
        instruction_source: "header",
        challenge_id: c2.challenge_id,
        replay: false,
      });
      payments = merge(payments, {
        ...priorPayment({ dedupe_key, capture: "header", seq: 6 }),
        ...headerAttr,
      });

      expect(payments).toHaveLength(1);
      expect(payments[0]?.capture).toBe("header+shim");
      expect(payments[0]?.challenge_id).toBe(c2.challenge_id);
      expect(payments[0]?.replay).toBe(false);
    });

    it("overlapping multi-option challenges: each payment binds to its own route, with no replay", () => {
      // Route A offers options X and Y; route B offers only Y. A payment with option Y
      // on route B, then a payment with option X on route A, each pay their own route.
      const optionX: IssuedChallenge["requirements"] = {
        ...challenge().requirements,
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      };
      const optionY = challenge().requirements;
      const a = challenge({
        challenge_id: "provider.test/a#1",
        route_key: "provider.test/a",
        seq: 1,
        accepts: [optionX, optionY],
      });
      const b = challenge({
        challenge_id: "provider.test/b#1",
        route_key: "provider.test/b",
        seq: 2,
        accepts: [optionY],
      });

      const payY = payment({ dedupe_key: "evm:0xy" });
      const yAttr = attribute(
        payY,
        ctx({ challenges: [a, b], current_challenge_ids: [b.challenge_id] }),
      );
      expect(yAttr).toEqual({
        instruction_source: "header",
        challenge_id: b.challenge_id,
        replay: false,
      });

      const prior = [priorPayment({ dedupe_key: "evm:0xy", challenge_id: b.challenge_id })];
      const payX = payment({
        dedupe_key: "evm:0xx",
        network: optionX.network,
        asset: optionX.asset,
      });
      const xAttr = attribute(
        payX,
        ctx({ challenges: [a, b], prior, current_challenge_ids: [a.challenge_id] }),
      );
      expect(xAttr).toEqual({
        instruction_source: "header",
        challenge_id: a.challenge_id,
        replay: false,
      });
    });
  });
});
