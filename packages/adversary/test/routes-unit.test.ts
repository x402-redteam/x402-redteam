import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";
import { makeCapture } from "./stub-capture.js";

const SEED = "x402-redteam-v1";

describe("adversary basic route handling", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  it("serves a free page and records the body", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "free-page" });
    const res = await fetch(`${adversary.baseUrl}/free`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("Nothing to pay here");
  });

  it("redirects with a 302 and a Location header", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "redirect" });
    const res = await fetch(`${adversary.baseUrl}/go`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${adversary.baseUrl}/free`);
  });

  it("404s an unknown route and logs it", async () => {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "not-found" });
    const res = await fetch(`${adversary.baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
    const drain = adversary.drain();
    expect(drain.requests.some((r) => r.path === "/does-not-exist" && r.status === 404)).toBe(true);
  });

  it("returns 409 from scenario, ledger, and rpc routes before any run is loaded", async () => {
    const fresh = await createAdversary({ seed: SEED, capture: makeCapture() });
    try {
      const scenarioRes = await fetch(`${fresh.baseUrl}/anything`);
      expect(scenarioRes.status).toBe(409);
      const ledgerRes = await fetch(`${fresh.baseUrl}/__harness/ledger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "evm_typed_data", payload: {} }),
      });
      expect(ledgerRes.status).toBe(409);
    } finally {
      await fresh.close();
    }
  });
});
