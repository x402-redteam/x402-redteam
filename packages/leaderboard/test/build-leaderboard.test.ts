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
import {
  buildLeaderboard,
  type LeaderboardEntry,
  type RejectedRow,
} from "../src/build-leaderboard.js";
import type { ResultsMeta } from "../src/load-results.js";

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

/** A control scenario, so `summary.valid` can be true (functional-design.md §3.4 /
 * ADR-009): a report against `CURRENT_SCENARIOS` with `controls_included: true` and no
 * control run is itself invalid (zero control runs never vacuously passes). */
const CONTROL_SCENARIO = scenario({
  id: "ctrl",
  category: "control",
  expected: { allow: true, max_usd: 1, min_payments: 1, require_delivered: true },
});

/** Two attack scenarios plus one control, standing in for "the current corpus". */
const CURRENT_SCENARIOS = [
  scenario({ id: "s1", expected: { allow: false } }),
  scenario({ id: "s2", expected: { allow: false } }),
  CONTROL_SCENARIO,
];

/** A differently-shaped corpus, standing in for "an older corpus". */
const OLD_SCENARIOS = [scenario({ id: "s1", title: "Old scenario", expected: { allow: false } })];
const OLD_HASH = corpusHash(OLD_SCENARIOS);

/** A run that satisfies `CONTROL_SCENARIO`'s utility requirement. */
function passingControlRun(overrides: Record<string, unknown> = {}): RunRecord {
  return run({
    run_id: "ctrl:evm:1",
    scenario_id: "ctrl",
    payments: [payment({ payment_id: "ctrl-p1", amount_usd: 1, dedupe_key: "ctrl-nonce-1" })],
    delivered: true,
    ...overrides,
  });
}

/** The canonical CLI configuration (functional-design.md §3.3). */
const CANONICAL_CONFIG: import("@x402-redteam/scorer").RunConfig = {
  seed: "x402-redteam-v1",
  chains: ["evm", "svm"],
  repeat: 1,
  timeout_s: 60,
  fail_on: "low" as const,
  scenario_filter: null,
  controls_included: true,
};

function buildReport(opts: {
  guardrailId: string;
  runs: RunRecord[];
  scenarios?: Scenario[];
  harnessVersion?: string;
  config?: Partial<typeof CANONICAL_CONFIG>;
  seed?: string;
}): Report {
  // Auto-append a passing control run when the default scenarios (which include
  // CONTROL_SCENARIO) are in play, so every `buildReport` call is `summary.valid: true`
  // unless the caller deliberately breaks something - custom `scenarios` callers stay
  // in full control of their own runs[].
  const runs = opts.scenarios === undefined ? [...opts.runs, passingControlRun()] : opts.runs;
  return scoreSuite({
    scenarios: opts.scenarios ?? CURRENT_SCENARIOS,
    runs,
    ctx: { seed: opts.seed ?? CANONICAL_CONFIG.seed },
    meta: {
      harness_version: opts.harnessVersion ?? "0.0.1",
      agent_id: "test-agent",
      guardrail_id: opts.guardrailId,
      config: { ...CANONICAL_CONFIG, ...opts.config },
    },
  });
}

/** A valid, accepted entry: the canonical config, against `CURRENT_SCENARIOS`, with a
 * filename equal to its own `guardrail_id`. */
function acceptedEntry(id: string, overrides: Record<string, unknown> = {}): LeaderboardEntry {
  const report = buildReport({
    guardrailId: id,
    runs: [
      run({ run_id: "s1:evm:1", scenario_id: "s1" }),
      run({ run_id: "s2:evm:1", scenario_id: "s2" }),
    ],
  });
  return { id, data: { ...report, ...overrides } };
}

function rejectedIds(rejected: RejectedRow[]): string[] {
  return rejected.map((r) => r.id);
}

const NO_META: ResultsMeta = {};

describe("buildLeaderboard: acceptance checks (functional-design.md §3)", () => {
  it("check 1: rejects a report whose schema isn't x402-redteam/report@2", () => {
    const entry: LeaderboardEntry = { id: "old", data: { schema: "x402-redteam/report@1" } };
    const { ranked, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["old"]);
    expect(rejected[0]?.reason).toMatch(/report@2/);
  });

  it("check 2: a corpus_hash mismatch is Stale, not Rejected", () => {
    const stale = buildReport({
      guardrailId: "stale-guardrail",
      scenarios: OLD_SCENARIOS,
      runs: [run({ run_id: "s1:evm:1", scenario_id: "s1" })],
    });
    const entry: LeaderboardEntry = { id: "stale-guardrail", data: stale };
    const {
      ranked,
      rejected,
      stale: staleRows,
    } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejected).toEqual([]);
    expect(staleRows.map((r) => r.id)).toEqual(["stale-guardrail"]);
  });

  it("check 3: rejects a non-canonical chains list (an evm-only report)", () => {
    const entry = acceptedEntry("evm-only", {
      config: { ...CANONICAL_CONFIG, chains: ["evm"] },
    });
    const { ranked, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["evm-only"]);
    expect(rejected[0]?.reason).toMatch(/chains/);
  });

  it("check 3: rejects a non-default seed", () => {
    const entry = acceptedEntry("odd-seed", {
      config: { ...CANONICAL_CONFIG, seed: "not-the-canonical-seed" },
    });
    const { ranked, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["odd-seed"]);
    expect(rejected[0]?.reason).toMatch(/seed/);
  });

  it("check 3: rejects --skip-controls (config.controls_included: false, summary.valid: null)", () => {
    const report = buildReport({
      guardrailId: "skip-controls",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
      config: { controls_included: false },
    });
    expect(report.summary.valid).toBeNull();
    const entry: LeaderboardEntry = { id: "skip-controls", data: report };
    const { ranked, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["skip-controls"]);
    expect(rejected[0]?.reason).toMatch(/controls_included/);
  });

  it("check 4: rejects an invalid suite (a control run failed, e.g. the `true` agent)", () => {
    const control = scenario({
      id: "c1",
      category: "control",
      expected: { allow: true, max_usd: 1, min_payments: 1 },
    });
    const scenarios = [...CURRENT_SCENARIOS, control];
    const report = scoreSuite({
      scenarios,
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
        run({ run_id: "c1:evm:1", scenario_id: "c1" }), // no payments: fails the control
      ],
      ctx: { seed: CANONICAL_CONFIG.seed },
      meta: {
        harness_version: "0.0.1",
        agent_id: "true-agent",
        guardrail_id: "invalid-suite",
        config: CANONICAL_CONFIG,
      },
    });
    expect(report.summary.valid).toBe(false);
    const entry: LeaderboardEntry = { id: "invalid-suite", data: report };
    const { ranked, rejected } = buildLeaderboard([entry], scenarios, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["invalid-suite"]);
    expect(rejected[0]?.reason).toMatch(/valid/);
  });

  it("check 5: rejects a tampered summary.unauthorized_usd (re-score mismatch)", () => {
    const entry = acceptedEntry("tampered");
    const report = entry.data as Report;
    const tampered: LeaderboardEntry = {
      id: "tampered",
      data: { ...report, summary: { ...report.summary, unauthorized_usd: 999999 } },
    };
    const { ranked, rejected } = buildLeaderboard([tampered], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["tampered"]);
    expect(rejected[0]?.reason).toMatch(/re-score mismatch/);
  });

  it("check 6: rejects a filename/id mismatch", () => {
    const report = buildReport({
      guardrailId: "the-real-id",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const entry: LeaderboardEntry = { id: "a-different-filename", data: report };
    const { ranked, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["a-different-filename"]);
    expect(rejected[0]?.reason).toMatch(/does not match guardrail_id/);
  });

  it("check 6: rejects both entries when two result files embed the same guardrail_id", () => {
    // Each entry individually passes "filename stem equals guardrail_id" (check 6's
    // first half); this models the id colliding across files some other way (e.g. a
    // case-insensitive filesystem, or two files added in the same PR) - the second half
    // of check 6 catches it at the aggregate level.
    const reportA = buildReport({
      guardrailId: "dupe",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const entries: LeaderboardEntry[] = [
      { id: "dupe", data: reportA },
      { id: "dupe", data: reportA },
    ];
    const { ranked, rejected } = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.id === "dupe")).toBe(true);
    expect(rejected[0]?.reason).toMatch(/duplicate guardrail_id/);
  });

  it("accepts a well-formed, canonical, re-scorable, correctly-named report", () => {
    const entry = acceptedEntry("clean");
    const { ranked, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(rejected).toEqual([]);
    expect(ranked.map((r) => r.id)).toEqual(["clean"]);
  });

  it(
    "re-score tolerates the non-reproducible excessive_authorization_window violation " +
      "(authorization_seconds is never persisted in report.json)",
    () => {
      const authScenario = scenario({
        id: "auth",
        expected: { allow: true, max_usd: 0.01, max_authorization_seconds: 300 },
      });
      const scenarios = [...CURRENT_SCENARIOS, authScenario];
      const runWithAuthWindow = run({
        run_id: "auth:evm:1",
        scenario_id: "auth",
        payments: [payment({ authorization_seconds: 10_000 })],
      });
      const report = scoreSuite({
        scenarios,
        runs: [
          run({ run_id: "s1:evm:1", scenario_id: "s1" }),
          run({ run_id: "s2:evm:1", scenario_id: "s2" }),
          passingControlRun(),
          runWithAuthWindow,
        ],
        ctx: { seed: CANONICAL_CONFIG.seed },
        meta: {
          harness_version: "0.0.1",
          agent_id: "test-agent",
          guardrail_id: "auth-window",
          config: CANONICAL_CONFIG,
        },
      });
      // Confirm the fixture actually exercises the violation before asserting on it.
      const authReport = report.scenarios.find((s) => s.id === "auth");
      expect(
        authReport?.results[0]?.worst.violations.some(
          (v) => v.code === "excessive_authorization_window",
        ),
      ).toBe(true);

      const entry: LeaderboardEntry = { id: "auth-window", data: report };
      const { ranked, rejected } = buildLeaderboard([entry], scenarios, NO_META);
      expect(rejected).toEqual([]);
      expect(ranked.map((r) => r.id)).toEqual(["auth-window"]);
    },
  );
});

describe("buildLeaderboard: ranking, columns and kind (functional-design.md §4)", () => {
  it("ranks by safety_score descending, then capped unauthorized $ ascending, then id", () => {
    const alpha = acceptedEntry("alpha"); // safety 100 (no payments, kind allow:false so 0 payments = pass)
    const betaReport = buildReport({
      guardrailId: "beta",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1", payments: [payment({ amount_usd: 5 })] }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const gammaReport = buildReport({
      guardrailId: "gamma",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1", payments: [payment({ amount_usd: 2 })] }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });

    const entries: LeaderboardEntry[] = [
      { id: "beta", data: betaReport },
      { id: "alpha", data: alpha.data },
      { id: "gamma", data: gammaReport },
    ];

    const { ranked } = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);

    expect(ranked.map((r) => r.id)).toEqual(["alpha", "gamma", "beta"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked[0]?.safetyScore).toBe(100);
    expect(ranked[1]?.unauthorizedUsd).toBeLessThan(ranked[2]?.unauthorizedUsd ?? Number.NaN);
  });

  it("labels an entry's kind from results/_meta.json, defaulting to submitted", () => {
    const entries: LeaderboardEntry[] = [
      acceptedEntry("naive-baseline"),
      acceptedEntry("someone-else"),
    ];
    const meta: ResultsMeta = { "naive-baseline": { kind: "reference" } };

    const { ranked } = buildLeaderboard(entries, CURRENT_SCENARIOS, meta);

    expect(ranked.find((r) => r.id === "naive-baseline")?.kind).toBe("reference");
    expect(ranked.find((r) => r.id === "someone-else")?.kind).toBe("submitted");
  });

  it("renders the addendum banner and the '#' column header, not 'rank'", () => {
    const { markdown } = buildLeaderboard([acceptedEntry("solo")], CURRENT_SCENARIOS, NO_META);
    expect(markdown).toContain(
      "Unranked / experimental: scores are not yet comparable across guardrails (see ADR-010)",
    );
    expect(markdown).toMatch(/\|\s*#\s*\|\s*entry\s*\|/);
    expect(markdown).not.toMatch(/\|\s*rank\s*\|/);
  });
});

describe("buildLeaderboard: rendering", () => {
  it("produces byte-identical markdown for the same input", () => {
    const entries: LeaderboardEntry[] = [acceptedEntry("solo")];

    const first = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);
    const second = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);

    expect(first.markdown).toBe(second.markdown);
    expect(first.markdown.endsWith("\n")).toBe(true);
  });

  it("renders empty ranked/rejected/stale sections gracefully", () => {
    const { markdown, ranked, stale, rejected } = buildLeaderboard([], CURRENT_SCENARIOS, NO_META);
    expect(ranked).toEqual([]);
    expect(stale).toEqual([]);
    expect(rejected).toEqual([]);
    expect(markdown).toContain("no accepted results");
    expect(markdown).toContain("## Rejected");
    expect(markdown).toContain("## Stale corpus");
  });

  it("still supports the Stale corpus section end to end", () => {
    const current = acceptedEntry("current-guardrail");
    const staleReport = buildReport({
      guardrailId: "stale-guardrail",
      scenarios: OLD_SCENARIOS,
      runs: [run({ run_id: "s1:evm:1", scenario_id: "s1" })],
      harnessVersion: "0.0.0-old",
    });
    const entries: LeaderboardEntry[] = [current, { id: "stale-guardrail", data: staleReport }];

    const { ranked, stale, markdown } = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);

    expect(ranked.map((r) => r.id)).toEqual(["current-guardrail"]);
    expect(stale.map((r) => r.id)).toEqual(["stale-guardrail"]);
    expect(stale[0]?.corpusHashShort).toBe(OLD_HASH.slice(0, 10));
    expect(markdown).toContain("Stale corpus");
    expect(markdown).toContain("stale-guardrail");
  });
});
