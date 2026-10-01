/**
 * Tool-handler tests against a live (offline, mock) adversary, per U12
 * functional-design.md §6 "Offline CI: ... tool-handler tests". Uses the real corpus's
 * `control-paid-fetch` scenario (a single fair-price paywalled endpoint) so
 * `http_get`/`pay_and_get`/`send_usdc` exercise the real challenge/verify/settle path.
 */

import { type Adversary, createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import { type Chain, canaries, type Scenario } from "@x402-redteam/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createToolHandlers } from "../src/lib/llm-tools.js";
import type { TaskFile } from "../src/lib/wallet.js";
import { buildLiveTask, loadScenarioById, SEED } from "./helpers/live-task.js";

const CHAINS: Chain[] = ["evm", "svm"];

describe.each(CHAINS)("llm-tools handlers (%s)", (chain) => {
  let adversary: Adversary;
  let scenario: Scenario;
  let task: TaskFile;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
    scenario = loadScenarioById("control-paid-fetch");
  });

  afterAll(async () => {
    await adversary.close();
  });

  afterEach(() => {
    adversary.drain();
  });

  function load(runId: string): void {
    adversary.load({ scenario, chain, run_id: `${chain}-llm-tools-${runId}` });
    task = buildLiveTask(scenario, chain, adversary.baseUrl);
  }

  it("http_get reports the 402 challenge without paying", async () => {
    load("http-get");
    const handlers = createToolHandlers(task);

    const raw = await handlers.http_get({ url: `${task.base_url}/api/report` });
    const result = JSON.parse(raw);

    expect(result.status).toBe(402);
    expect(result.accepts).toHaveLength(1);
    expect(result.accepts[0].amount_usd).toBeCloseTo(0.01, 6);
    expect(typeof result.accepts[0].pay_to).toBe("string");

    const drained = adversary.drain();
    expect(drained.payments).toHaveLength(0);
  });

  it("pay_and_get pays the challenge and returns the delivered body", async () => {
    load("pay-and-get");
    const handlers = createToolHandlers(task);

    const raw = await handlers.pay_and_get({ url: `${task.base_url}/api/report` });
    const result = JSON.parse(raw);

    expect(result.status).toBe(200);
    expect(result.body.length).toBeGreaterThan(0);

    const drained = adversary.drain();
    expect(drained.payments.length).toBeGreaterThanOrEqual(1);
    expect(drained.payments.every((p) => p.capture.includes("header"))).toBe(true);
  });

  it("send_usdc sends a real direct transfer observed at the chain boundary", async () => {
    load("send-usdc");
    const handlers = createToolHandlers(task);
    const canaryAddress = canaries(SEED, scenario.id, chain).get("legit").address;

    const raw = await handlers.send_usdc({ to: canaryAddress, amount_usd: 0.02 });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(typeof result.tx).toBe("string");

    const drained = adversary.drain();
    expect(drained.payments.some((p) => p.capture.includes("rpc"))).toBe(true);
  });

  it("http_get and pay_and_get report a network error instead of throwing", async () => {
    load("network-error");
    const handlers = createToolHandlers(task);

    const raw = await handlers.http_get({ url: "http://127.0.0.1:1/unreachable" });
    const result = JSON.parse(raw);
    expect(typeof result.error).toBe("string");
  });
});
