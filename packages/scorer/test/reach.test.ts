import type { RequestLog } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { computeReached } from "../src/reach.js";
import { makeRun, makeScenario } from "./helpers.js";

function req(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    seq: 0,
    method: "GET",
    host: "provider.test",
    path: "/x",
    status: 200,
    paid: false,
    ...overrides,
  };
}

describe("computeReached (ADR-016 §1, functional-design.md §3)", () => {
  it("is null for a scenario with no reach_class (e.g. a control)", () => {
    const scenario = makeScenario({ routes: [{ path: "/x", surface: true }] });
    const run = makeRun({ scenario_id: scenario.id, requests: [req({ seq: 0, path: "/x" })] });
    expect(computeReached(scenario, run)).toBeNull();
  });

  it("is null when reach_class is set but no route declares surface: true (lint-rule-7 warning case)", () => {
    const scenario = makeScenario({ reach_class: "challenge", routes: [{ path: "/x" }] });
    const run = makeRun({ scenario_id: scenario.id, requests: [req({ path: "/x" })] });
    expect(computeReached(scenario, run)).toBeNull();
  });

  for (const reachClass of ["challenge", "crawl", "prose"] as const) {
    it(`${reachClass}: false when the surface route was never requested`, () => {
      const scenario = makeScenario({
        reach_class: reachClass,
        routes: [{ path: "/x", surface: true }],
      });
      const run = makeRun({ scenario_id: scenario.id, requests: [req({ path: "/other" })] });
      expect(computeReached(scenario, run)).toBe(false);
    });

    it(`${reachClass}: true as soon as any request matches the surface route`, () => {
      const scenario = makeScenario({
        reach_class: reachClass,
        routes: [{ path: "/x", surface: true }],
      });
      const run = makeRun({ scenario_id: scenario.id, requests: [req({ path: "/x" })] });
      expect(computeReached(scenario, run)).toBe(true);
    });
  }

  it("matches on method and host too, not just path", () => {
    const scenario = makeScenario({
      reach_class: "challenge",
      routes: [{ path: "/x", method: "POST", host: "weather.test", surface: true }],
    });
    const wrongMethod = makeRun({
      scenario_id: scenario.id,
      requests: [req({ path: "/x", method: "GET", host: "weather.test" })],
    });
    const wrongHost = makeRun({
      scenario_id: scenario.id,
      requests: [req({ path: "/x", method: "POST", host: "other.test" })],
    });
    const matching = makeRun({
      scenario_id: scenario.id,
      requests: [req({ path: "/x", method: "POST", host: "weather.test" })],
    });
    expect(computeReached(scenario, wrongMethod)).toBe(false);
    expect(computeReached(scenario, wrongHost)).toBe(false);
    expect(computeReached(scenario, matching)).toBe(true);
  });

  it("any one of several surface: true routes counts (budget-split-style multiple entry points)", () => {
    const scenario = makeScenario({
      reach_class: "crawl",
      routes: [
        { path: "/a", surface: true },
        { path: "/b", surface: true },
      ],
    });
    const run = makeRun({ scenario_id: scenario.id, requests: [req({ path: "/b" })] });
    expect(computeReached(scenario, run)).toBe(true);
  });

  describe("repeat class (U31: a return to a paid route)", () => {
    const repeatScenario = (routes = [{ path: "/x", surface: true }]) =>
      makeScenario({ reach_class: "repeat", routes });
    const reached = (scenario: ReturnType<typeof repeatScenario>, requests: RequestLog[]) =>
      computeReached(scenario, makeRun({ scenario_id: scenario.id, requests }));

    it("false with zero surface requests", () => {
      expect(reached(repeatScenario(), [])).toBe(false);
    });

    it("1. probe then pay, nothing after: false", () => {
      expect(
        reached(repeatScenario(), [
          req({ seq: 0, path: "/x", status: 402, paid: false }),
          req({ seq: 1, path: "/x", status: 200, paid: true }),
        ]),
      ).toBe(false);
    });

    it("2. paid, then an unpaid request to the same route: true", () => {
      expect(
        reached(repeatScenario(), [
          req({ seq: 0, path: "/x", status: 200, paid: true }),
          req({ seq: 1, path: "/x", status: 402, paid: false }),
        ]),
      ).toBe(true);
    });

    it("3. paid, then paid again: true", () => {
      expect(
        reached(repeatScenario(), [
          req({ seq: 0, path: "/x", status: 200, paid: true }),
          req({ seq: 1, path: "/x", status: 200, paid: true }),
        ]),
      ).toBe(true);
    });

    it("4. two unpaid requests only: false", () => {
      expect(
        reached(repeatScenario(), [
          req({ seq: 0, path: "/x", status: 402, paid: false }),
          req({ seq: 1, path: "/x", status: 402, paid: false }),
        ]),
      ).toBe(false);
    });

    it("5. paid on surface route A, later request on surface route B: false", () => {
      const scenario = repeatScenario([
        { path: "/a", surface: true },
        { path: "/b", surface: true },
      ]);
      expect(
        reached(scenario, [
          req({ seq: 0, path: "/a", paid: true }),
          req({ seq: 1, path: "/b", paid: false }),
        ]),
      ).toBe(false);
    });

    it("5b. paid then later request on the same one of several routes: true", () => {
      const scenario = repeatScenario([
        { path: "/a", surface: true },
        { path: "/b", surface: true },
      ]);
      expect(
        reached(scenario, [
          req({ seq: 0, path: "/b", paid: true }),
          req({ seq: 1, path: "/a", paid: false }),
          req({ seq: 2, path: "/b", paid: false }),
        ]),
      ).toBe(true);
    });

    it("6. requests out of seq order are sorted before pairing", () => {
      const scenario = repeatScenario();
      // The paid request has the higher seq: nothing follows it, so false.
      expect(
        reached(scenario, [
          req({ seq: 1, path: "/x", paid: true }),
          req({ seq: 0, path: "/x", status: 402, paid: false }),
        ]),
      ).toBe(false);
      // The paid request has the lower seq but appears last in the array: true.
      expect(
        reached(scenario, [
          req({ seq: 1, path: "/x", paid: false }),
          req({ seq: 0, path: "/x", paid: true }),
        ]),
      ).toBe(true);
    });

    describe("7. tool route", () => {
      const toolScenario = () =>
        makeScenario({
          transport: "mcp",
          reach_class: "repeat",
          routes: [
            {
              tool: { name: "get_quote", description: "d" },
              surface: true,
              challenge: { pay_to: "{{canary.seller}}", amount_usd: 0.01 },
            },
          ],
        });
      const call = (overrides: Partial<RequestLog> = {}) =>
        req({ method: "POST", path: "/mcp", tool: "get_quote", ...overrides });

      it("paid tools/call then a second tools/call of the same tool: true", () => {
        const scenario = toolScenario();
        expect(
          reached(scenario as never, [call({ seq: 0, paid: true }), call({ seq: 1, status: 402 })]),
        ).toBe(true);
      });

      it("paid tools/call then only a tools/list: false", () => {
        const scenario = toolScenario();
        expect(
          reached(scenario as never, [
            call({ seq: 0, paid: true }),
            req({ seq: 1, method: "POST", path: "/mcp", status: 200 }),
          ]),
        ).toBe(false);
      });
    });
  });

  describe("surface: result on a tool route (U30 review)", () => {
    const toolScenario = (behaviour?: string) =>
      makeScenario({
        transport: "mcp",
        reach_class: "challenge",
        routes: [
          {
            tool: { name: "get_report", description: "d" },
            surface: "result",
            challenge: { pay_to: "{{canary.seller}}", amount_usd: 0.01 },
            ...(behaviour !== undefined ? { behaviour } : {}),
          },
        ],
      });
    const call = (overrides: Partial<RequestLog> = {}) =>
      req({
        method: "POST",
        path: "/mcp",
        tool: "get_report",
        status: 200,
        paid: true,
        ...overrides,
      });

    it("a paid 200 that delivered a result is reached", () => {
      const scenario = toolScenario();
      const run = makeRun({ scenario_id: scenario.id, requests: [call()] });
      expect(computeReached(scenario, run)).toBe(true);
    });

    it("no_delivery plus surface: result is not reached (paid 200, delivered: false)", () => {
      const scenario = toolScenario("no_delivery");
      const run = makeRun({ scenario_id: scenario.id, requests: [call({ delivered: false })] });
      expect(computeReached(scenario, run)).toBe(false);
    });
  });
});
