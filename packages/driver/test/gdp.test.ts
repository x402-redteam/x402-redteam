import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GdpClient } from "../src/gdp.js";
import type { GdpPaymentResponse } from "../src/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => resolve(__dirname, "fixtures", name);

const SHORT_TIMEOUT_MS = 200;

function paymentRequest(id: number) {
  return {
    id,
    type: "payment" as const,
    request: { url: "http://example.test/x", method: "GET" },
    referrer: null,
    rail: "x402v2" as const,
    challenge: { accepts: [], resource: {}, raw_body: null },
    history: [],
  };
}

describe("GdpClient", () => {
  it("denies and logs on a hook timeout", async () => {
    const logs: string[] = [];
    const gdp = new GdpClient(
      `node "${fixture("silent.mjs")}"`,
      process.env,
      (m) => logs.push(m),
      SHORT_TIMEOUT_MS,
    );
    const start = Date.now();
    const res = (await gdp.request((id) => paymentRequest(id))) as GdpPaymentResponse;
    const elapsed = Date.now() - start;
    expect(res.decision).toBe("deny");
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS - 20);
    expect(logs.some((l) => l.includes("hook timeout"))).toBe(true);
    gdp.close();
  });

  it("denies and logs on a malformed response line", async () => {
    const logs: string[] = [];
    const gdp = new GdpClient(
      `node "${fixture("malformed-then-silent.mjs")}"`,
      process.env,
      (m) => logs.push(m),
      SHORT_TIMEOUT_MS,
    );
    const res = (await gdp.request((id) => paymentRequest(id))) as GdpPaymentResponse;
    expect(res.decision).toBe("deny");
    expect(logs.some((l) => l.includes("malformed JSON line"))).toBe(true);
    gdp.close();
  });

  it("denies and logs on a response id that doesn't match the request", async () => {
    const logs: string[] = [];
    const gdp = new GdpClient(
      `node "${fixture("wrong-id.mjs")}"`,
      process.env,
      (m) => logs.push(m),
      SHORT_TIMEOUT_MS,
    );
    const res = (await gdp.request((id) => paymentRequest(id))) as GdpPaymentResponse;
    expect(res.decision).toBe("deny");
    expect(logs.some((l) => l.includes("id mismatch"))).toBe(true);
    gdp.close();
  });

  it("denies immediately (not after the timeout) once the guardrail has exited, for every subsequent request", async () => {
    const logs: string[] = [];
    // A large timeout, so an immediate deny proves it came from exit-detection, not from
    // the timeout firing.
    const gdp = new GdpClient(
      `node "${fixture("hello-then-exit.mjs")}"`,
      process.env,
      (m) => logs.push(m),
      5000,
    );

    const hello = await gdp.hello({
      prompt: "",
      chain: "evm",
      network: "eip155:84532",
      budget_usd: 0,
      allowed_hosts: [],
      wallet_address: "0x0",
      wallet_balance_usd: 100,
      host_mode: "path",
    });
    expect(hello.hooks).toEqual([]);

    const start = Date.now();
    const first = (await gdp.request((id) => paymentRequest(id))) as GdpPaymentResponse;
    const elapsed = Date.now() - start;
    expect(first.decision).toBe("deny");
    expect(elapsed).toBeLessThan(1000);

    const secondStart = Date.now();
    const second = (await gdp.request((id) => paymentRequest(id))) as GdpPaymentResponse;
    expect(second.decision).toBe("deny");
    expect(Date.now() - secondStart).toBeLessThan(50);

    gdp.close();
  });
});
