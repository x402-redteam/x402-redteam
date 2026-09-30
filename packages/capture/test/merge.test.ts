import type { Payment } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { merge } from "../src/merge.js";

function headerPayment(overrides: Partial<Payment> = {}): Payment {
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
    route_key: "provider.test/weather/today",
    host: "provider.test",
    dedupe_key: "evm:0xnonce1",
    instruction_source: "header",
    challenge_id: "provider.test/weather/today#0",
    replay: false,
    valid: true,
    ...overrides,
  };
}

function shimPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    payment_id: "p1",
    seq: 1,
    capture: "shim",
    chain: "evm",
    network: "eip155:84532",
    scheme: "exact",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    from: "0x1111111111111111111111111111111111111111",
    to: "0xAbCdEf0000000000000000000000000000001234",
    amount_atomic: "1000",
    amount_usd: 0.001,
    dedupe_key: "evm:0xnonce1",
    instruction_source: "none",
    replay: false,
    valid: true,
    ...overrides,
  };
}

/** v2 (ADR-013): a direct transfer observed at the mock chain RPC boundary. */
function rpcPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    payment_id: "p2",
    seq: 2,
    capture: "rpc",
    chain: "evm",
    network: "eip155:84532",
    scheme: "transfer",
    asset: "native",
    from: "0x1111111111111111111111111111111111111111",
    to: "0xAbCdEf0000000000000000000000000000001234",
    amount_atomic: "500",
    amount_usd: 0.0005,
    dedupe_key: "evmtx:0xdeadbeef",
    instruction_source: "prose",
    replay: false,
    valid: true,
    ...overrides,
  };
}

describe("merge", () => {
  it("merges a shim capture into an existing header capture, taking route/host/challenge_id/instruction_source from the header side", () => {
    const header = headerPayment();
    const shim = shimPayment({ seq: 1 });
    const result = merge([header], shim);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      capture: "header+shim",
      route_key: header.route_key,
      host: header.host,
      challenge_id: header.challenge_id,
      instruction_source: header.instruction_source,
      seq: 0,
    });
  });

  it("merges a header capture into an existing shim capture, taking route/host/challenge_id/instruction_source from the header side", () => {
    const shim = shimPayment({ seq: 0 });
    const header = headerPayment({ seq: 1 });
    const result = merge([shim], header);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      capture: "header+shim",
      route_key: header.route_key,
      host: header.host,
      challenge_id: header.challenge_id,
      instruction_source: header.instruction_source,
      seq: 0,
    });
  });

  it("keeps the lower seq and leaves replay unchanged (from the header side)", () => {
    const header = headerPayment({ seq: 5, replay: true });
    const shim = shimPayment({ seq: 2, replay: false });
    const result = merge([header], shim);
    expect(result[0]?.seq).toBe(2);
    expect(result[0]?.replay).toBe(true);
  });

  it("appends a payment with a distinct dedupe_key rather than merging, ordered by seq", () => {
    const first = headerPayment({ seq: 0, dedupe_key: "evm:0xnonce1" });
    const second = shimPayment({ seq: 1, dedupe_key: "evm:0xnonce2", capture: "shim" });
    const result = merge([first], second);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.dedupe_key)).toEqual(["evm:0xnonce1", "evm:0xnonce2"]);
    expect(result.map((p) => p.capture)).toEqual(["header", "shim"]);
  });

  // v2 (ADR-013, application-design.md §4 "Merge rule (v2)"): a shim event and an RPC
  // submission of the same transaction share a dedupe_key and merge into "rpc+shim",
  // not replay-flagged, with the rpc side (the actual chain-boundary observation)
  // taking priority over the self-reported shim side.
  it("merges an rpc capture into an existing shim capture into capture: rpc+shim, rpc side wins", () => {
    const shim = shimPayment({
      seq: 0,
      dedupe_key: "evmtx:0xdeadbeef",
      instruction_source: "none",
    });
    const rpc = rpcPayment({ seq: 1, dedupe_key: "evmtx:0xdeadbeef", instruction_source: "prose" });
    const result = merge([shim], rpc);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      capture: "rpc+shim",
      instruction_source: "prose",
      seq: 0,
    });
  });

  it("merges a shim capture into an existing rpc capture into capture: rpc+shim, rpc side still wins, lower seq kept", () => {
    const rpc = rpcPayment({
      seq: 3,
      dedupe_key: "evmtx:0xcafebabe",
      instruction_source: "prose",
      replay: false,
    });
    const shim = shimPayment({
      seq: 1,
      dedupe_key: "evmtx:0xcafebabe",
      instruction_source: "none",
      replay: true,
    });
    const result = merge([rpc], shim);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      capture: "rpc+shim",
      instruction_source: "prose",
      replay: false,
      seq: 1,
    });
  });

  it("a header capture never merges with an rpc capture (distinct dedupe_key schemes)", () => {
    const header = headerPayment({ seq: 0, dedupe_key: "evm:0xnonce1" });
    const rpc = rpcPayment({ seq: 1, dedupe_key: "evmtx:0xnonce1" });
    const result = merge([header], rpc);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.capture)).toEqual(["header", "rpc"]);
  });
});
