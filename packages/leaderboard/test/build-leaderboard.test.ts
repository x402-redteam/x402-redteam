import {
  type Payment,
  PaymentSchema,
  type RunRecord,
  RunRecordSchema,
  type Scenario,
  ScenarioSchema,
} from "@x402-redteam/schema";
import { corpusHash, type Report, scoreSuite } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";
import { buildLeaderboard, type LeaderboardEntry } from "../src/build-leaderboard.js";

/**
 * Hand-built fixtures validated through the schema package's own zod
 * parsers, mirroring the scorer package's own test-fixture convention
 * (@x402-redteam/scorer's test/helpers.ts is private to that package).
 */
function scenario(overrides: Record<string, unknown> = {}): Scenario {
  return ScenarioSchema.parse({
    id: "s1",
    title: "Scenario",
    category: "ghost_paywall",
    severity: "high",
    description: "A hand-built test scenario.",
    task: { prompt: "do the thing" },
    routes: [{ path: "/x" }],
    expected: { allow: false },
    ...overrides,
  });
}

function payment(overrides: Record<string, unknown> = {}): Payment {
  return PaymentSchema.parse({
    payment_id: "p1",
    seq: 1,
    capture: "header",
    chain: "evm",
    network: "eip155:84532",
    scheme: "exact",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    amount_atomic: "10000",
    amount_usd: 0.01,
    dedupe_key: "nonce-1",
    instruction_source: "header",
    replay: false,
    valid: true,
    ...overrides,
  });
}

function run(overrides: Record<string, unknown> = {}): RunRecord {
  return RunRecordSchema.parse({
    run_id: "s1:evm:1",
    scenario_id: "s1",
    chain: "evm",
    attempt: 1,
    agent_id: "agent",
    guardrail_id: "g",
    requests: [],
    challenges: [],
    payments: [],
    delivered: false,
    exit_code: 0,
    timed_out: false,
    timing: { duration_ms: 1 },
    ...overrides,
  });
}

/** Two scenarios standing in for "the current corpus". */
const CURRENT_SCENARIOS = [
  scenario({ id: "s1", expected: { allow: false } }),
  scenario({ id: "s2", expected: { allow: false } }),
];
const CURRENT_HASH = corpusHash(CURRENT_SCENARIOS);

/** A differently-shaped corpus, standing in for "an older corpus". */
const OLD_SCENARIOS = [scenario({ id: "s1", title: "Old scenario", expected: { allow: false } })];
const OLD_HASH = corpusHash(OLD_SCENARIOS);

function buildReport(opts: {
  guardrailId: string;
  runs: RunRecord[];
  scenarios?: Scenario[];
  harnessVersion?: string;
}): Report {
  return scoreSuite({
    scenarios: opts.scenarios ?? CURRENT_SCENARIOS,
    runs: opts.runs,
    ctx: { seed: "test-seed" },
    meta: {
      harness_version: opts.harnessVersion ?? "0.0.1",
      agent_id: "test-agent",
      guardrail_id: opts.guardrailId,
    },
  });
}

describe("buildLeaderboard", () => {
  it("ranks by scenarios passed descending, then unauthorized $ ascending", () => {
    const alpha = buildReport({
      guardrailId: "alpha",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const beta = buildReport({
      guardrailId: "beta",
      runs: [
        run({
          run_id: "s1:evm:1",
          scenario_id: "s1",
          payments: [payment({ amount_usd: 5 })],
        }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const gamma = buildReport({
      guardrailId: "gamma",
      runs: [
        run({
          run_id: "s1:evm:1",
          scenario_id: "s1",
          payments: [payment({ amount_usd: 2 })],
        }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });

    const entries: LeaderboardEntry[] = [
      { id: "beta", report: beta },
      { id: "alpha", report: alpha },
      { id: "gamma", report: gamma },
    ];

    const { ranked } = buildLeaderboard(entries, CURRENT_HASH);

    expect(ranked.map((r) => r.guardrailId)).toEqual(["alpha", "gamma", "beta"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked[0]?.scenariosPassed).toBe(2);
    expect(ranked[1]?.unauthorizedUsd).toBeLessThan(ranked[2]?.unauthorizedUsd ?? Number.NaN);
  });

  it("splits results with a stale corpus_hash out of the ranking", () => {
    const current = buildReport({
      guardrailId: "current-guardrail",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const stale = buildReport({
      guardrailId: "stale-guardrail",
      scenarios: OLD_SCENARIOS,
      runs: [run({ run_id: "s1:evm:1", scenario_id: "s1" })],
      harnessVersion: "0.0.0-old",
    });

    const entries: LeaderboardEntry[] = [
      { id: "current-guardrail", report: current },
      { id: "stale-guardrail", report: stale },
    ];

    const { ranked, stale: staleRows, markdown } = buildLeaderboard(entries, CURRENT_HASH);

    expect(ranked.map((r) => r.guardrailId)).toEqual(["current-guardrail"]);
    expect(staleRows.map((r) => r.guardrailId)).toEqual(["stale-guardrail"]);
    expect(staleRows[0]?.corpusHashShort).toBe(OLD_HASH.slice(0, 10));
    expect(markdown).toContain("Stale corpus");
    expect(markdown).toContain("stale-guardrail");
  });

  it("produces byte-identical markdown for the same input", () => {
    const report = buildReport({
      guardrailId: "solo",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const entries: LeaderboardEntry[] = [{ id: "solo", report }];

    const first = buildLeaderboard(entries, CURRENT_HASH);
    const second = buildLeaderboard(entries, CURRENT_HASH);

    expect(first.markdown).toBe(second.markdown);
    expect(first.markdown.endsWith("\n")).toBe(true);
  });

  it("renders an empty ranking table and an empty stale section gracefully", () => {
    const { markdown, ranked, stale } = buildLeaderboard([], CURRENT_HASH);
    expect(ranked).toEqual([]);
    expect(stale).toEqual([]);
    expect(markdown).toContain("no results");
  });
});
