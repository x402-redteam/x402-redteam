import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { createMcpGuard } from "../src/lib/mcp-guard.js";
import type { TaskFile } from "../src/lib/wallet.js";

const SERVER = "http://127.0.0.1:9000/mcp";

function task(budget: number): TaskFile {
  return {
    version: 4,
    run_id: "r",
    prompt: "Call `get_forecast` on http://127.0.0.1:9000/mcp.",
    base_url: "http://127.0.0.1:9000",
    chain: "evm",
    network: CHAIN_DEFAULTS.evm.network,
    budget_usd: budget,
    allowed_hosts: ["provider.test"],
  } as unknown as TaskFile;
}

function offer(amount = "10000"): PaymentRequirements {
  return {
    scheme: "exact",
    network: CHAIN_DEFAULTS.evm.network,
    asset: CHAIN_DEFAULTS.evm.asset,
    amount,
    payTo: "0x2222222222222222222222222222222222222222",
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

const required = (...accepts: PaymentRequirements[]): PaymentRequired =>
  ({ x402Version: 2, resource: { url: "mcp://tool/get_forecast" }, accepts }) as PaymentRequired;

/** An x402Client whose exact scheme fails its first `failures` creations, after selection. */
function setup(budget: number, failures: number) {
  const guard = createMcpGuard(task(budget));
  let creations = 0;
  const client = new x402Client();
  client.setSpendControls(false);
  client.register(
    "eip155:*" as never,
    {
      scheme: "exact",
      async createPaymentPayload() {
        creations += 1;
        if (creations <= failures) throw new Error("signer unavailable");
        return { x402Version: 2, payload: { signature: "0x" } };
      },
    } as never,
  );
  client.registerPolicy(guard.policy as never);
  guard.attach(client);
  guard.target(SERVER, "get_forecast");
  return { guard, client };
}

describe("mcp-guard: the running total is charged after a payload exists (U30 review)", () => {
  it("a creation that throws after selection costs nothing, and a later fair call is allowed", async () => {
    // Budget for one payment only: charging at selection time would block the retry.
    const { guard, client } = setup(0.015, 1);
    await expect(client.createPaymentPayload(required(offer()))).rejects.toThrow(
      "signer unavailable",
    );
    expect(guard.spentUsd()).toBe(0);
    expect(guard.onPaymentRequested({ paymentRequired: required(offer()) })).toBe(true);
    await client.createPaymentPayload(required(offer()));
    expect(guard.spentUsd()).toBeCloseTo(0.01, 9);
  });

  it("still refuses before signing once the running total would pass the budget", async () => {
    const { guard, client } = setup(0.015, 0);
    await client.createPaymentPayload(required(offer()));
    expect(guard.onPaymentRequested({ paymentRequired: required(offer()) })).toBe(false);
    await expect(client.createPaymentPayload(required(offer()))).rejects.toThrow(
      /filtered out by policies/,
    );
    expect(guard.spentUsd()).toBeCloseTo(0.01, 9);
    expect(guard.remainingUsd()).toBeCloseTo(0.005, 9);
  });
});
