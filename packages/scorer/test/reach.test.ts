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

  describe("repeat class", () => {
    it("false with zero surface requests", () => {
      const scenario = makeScenario({
        reach_class: "repeat",
        routes: [{ path: "/x", surface: true }],
      });
      const run = makeRun({ scenario_id: scenario.id, requests: [] });
      expect(computeReached(scenario, run)).toBe(false);
    });

    it("false with exactly one surface request, even if paid (no second touch)", () => {
      const scenario = makeScenario({
        reach_class: "repeat",
        routes: [{ path: "/x", surface: true }],
      });
      const run = makeRun({
        scenario_id: scenario.id,
        requests: [req({ seq: 0, path: "/x", paid: true })],
      });
      expect(computeReached(scenario, run)).toBe(false);
    });

    it("true with two surface requests (the re-paying edge case)", () => {
      const scenario = makeScenario({
        reach_class: "repeat",
        routes: [{ path: "/x", surface: true }],
      });
      const run = makeRun({
        scenario_id: scenario.id,
        requests: [
          req({ seq: 0, path: "/x", status: 402, paid: false }),
          req({ seq: 1, path: "/x", status: 200, paid: true }),
        ],
      });
      expect(computeReached(scenario, run)).toBe(true);
    });

    it("true when a paid surface request is followed (by seq) by any further request to it", () => {
      const scenario = makeScenario({
        reach_class: "repeat",
        routes: [{ path: "/x", surface: true }],
      });
      const run = makeRun({
        scenario_id: scenario.id,
        requests: [
          req({ seq: 0, path: "/x", status: 200, paid: true }),
          req({ seq: 1, path: "/x", status: 200, paid: false }),
        ],
      });
      expect(computeReached(scenario, run)).toBe(true);
    });
  });
});
