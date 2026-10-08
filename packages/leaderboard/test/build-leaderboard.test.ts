import { readFileSync } from "node:fs";
import {
  type Chain,
  type Payment,
  PaymentSchema,
  type RunRecord,
  RunRecordSchema,
  type Scenario,
  ScenarioSchema,
} from "@x402-redteam/schema";
import {
  corpusHash,
  type RedactedReport,
  type Report,
  type RunScore,
  redact,
  scoreSuite,
} from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";
import {
  buildLeaderboard as buildLeaderboardReal,
  type LeaderboardEntry,
  type RejectedRow,
} from "../src/build-leaderboard.js";
import { contentHash, type ResultsMeta, type SeasonRecords } from "../src/load-results.js";
import { RANK_SIGNER, RANKED_RUN_SIGNER, type VerifiedMap } from "../src/provenance.js";

/**
 * ADR-011 (U19) test shim: auto-verifies every guardrail-track `report@3` entry as Tier
 * 2 (signer `rank.yml`, matching `entry.sha256`'s own `subject_sha256` - security
 * review HIGH-5), so the pre-existing acceptance-check tests below (schema, canonical
 * config, rescore, run coverage, ranking/rendering - all written before tiers existed)
 * keep testing exactly what they tested before, without each one needing its own
 * `verified` map. Real tier/attestation behavior (Tier 1 redacted entries, Tier 2
 * gating, Tier 3 rejection) gets its own dedicated describe block at the end of this
 * file, which calls `buildLeaderboardReal` directly with an explicit `verified` map.
 * Reference-kind entries never need a `verified` entry (exempt from tier gating,
 * ORCHESTRATOR RULING) - this shim never bothers computing one for them either way.
 */
function autoVerified(entries: LeaderboardEntry[]): VerifiedMap {
  const out: VerifiedMap = {};
  for (const e of entries) {
    const data = e.data;
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { schema?: unknown }).schema === "x402-redteam/report@3" &&
      (data as { config?: { track?: unknown } }).config?.track === "guardrail"
    ) {
      out[e.id] = { tier: 2, signer: RANK_SIGNER, subject_sha256: e.sha256 ?? contentHash(data) };
    }
  }
  return out;
}

/** Security review condition #14: the default allowlist every test in this file uses
 * unless it explicitly wants to exercise `checkHarnessAllowlistConcrete`'s own
 * rejection - never the permissive `["*"]`/`[]` `buildLeaderboardReal`'s own default
 * would otherwise fall back to. */
function buildLeaderboard(
  entries: LeaderboardEntry[],
  scenarios: Scenario[],
  meta: ResultsMeta = {},
  harnessAllowlist: string[] = TEST_HARNESS_ALLOWLIST,
) {
  return buildLeaderboardReal(entries, scenarios, meta, harnessAllowlist, autoVerified(entries));
}

/**
 * Hand-built fixtures validated through the schema package's own zod
 * parsers, mirroring the scorer package's own test-fixture convention
 * (@x402-redteam/scorer's test/helpers.ts is private to that package).
 *
 * Code review round 1, item 1: defaults to a single declared chain (`evm`), not the
 * schema's own two-chain default - every fixture elsewhere in this file only ever
 * builds an `evm` run, and `checkRunCoverage` now requires *exactly* one run per
 * (scenario, chain, attempt) the scenario itself declares. A scenario that genuinely
 * wants to test the two-chain case passes `chains: ["evm", "svm"]` explicitly (see the
 * "run coverage" describe block below).
 */
function scenario(overrides: Record<string, unknown> = {}): Scenario {
  return ScenarioSchema.parse({
    id: "s1",
    title: "Scenario",
    category: "ghost_paywall",
    severity: "high",
    description: "A hand-built test scenario.",
    chains: ["evm"],
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

/** A run that satisfies `CONTROL_SCENARIO`'s utility requirement, for attempt 1. */
function passingControlRun(overrides: Record<string, unknown> = {}): RunRecord {
  return run({
    run_id: "ctrl:evm:1",
    scenario_id: "ctrl",
    payments: [payment({ payment_id: "ctrl-p1", amount_usd: 1, dedupe_key: "ctrl-nonce-1" })],
    delivered: true,
    ...overrides,
  });
}

/** `repeat` passing control runs, one per attempt (1..repeat) - code review round 1,
 * item 1: `checkRunCoverage` now requires exactly `config.repeat` control attempts too
 * ("incl. controls"), not just one regardless of the declared repeat. */
function passingControlRuns(repeat: number): RunRecord[] {
  return Array.from({ length: repeat }, (_, i) => {
    const attempt = i + 1;
    return passingControlRun({
      run_id: `ctrl:evm:${attempt}`,
      attempt,
      payments: [
        payment({
          payment_id: `ctrl-p${attempt}`,
          amount_usd: 1,
          dedupe_key: `ctrl-nonce-${attempt}`,
        }),
      ],
    });
  });
}

/** `repeat` runs of one scenario on one chain, attempts 1..repeat - the general-purpose
 * fixture builder every "N attempts" test below uses (code review round 1, item 1). */
function repeatedRuns(
  scenarioId: string,
  chain: Chain,
  repeat: number,
  overrides: (attempt: number) => Record<string, unknown> = () => ({}),
): RunRecord[] {
  return Array.from({ length: repeat }, (_, i) => {
    const attempt = i + 1;
    return run({
      run_id: `${scenarioId}:${chain}:${attempt}`,
      scenario_id: scenarioId,
      chain,
      attempt,
      ...overrides(attempt),
    });
  });
}

/**
 * The canonical CLI configuration (functional-design.md §3.3 + ADR-016 §3's full v3
 * fingerprint, U16): the guardrail track's own canonical shape, since it's the only
 * ranked track at launch (ADR-010 §1) - `driver@1`, a non-empty `guardrail_hooks`,
 * `host_mode: "localhost"`, and `repeat: 1` (the only canonical value for a
 * deterministic guardrail - code review round 1, item 6). `harness_commit` is a
 * 40-hex-char placeholder SHA (code review round 1, item 4: the real field must look
 * like a git commit, or the literal "unknown").
 */
const CANONICAL_CONFIG: import("@x402-redteam/scorer").RunConfig = {
  seed: "x402-redteam-v1",
  chains: ["evm", "svm"],
  repeat: 1,
  timeout_s: 60,
  fail_on: "low" as const,
  scenario_filter: null,
  controls_included: true,
  startup_timeout_s: 120,
  host_mode: "localhost",
  track: "guardrail",
  driver: "driver@1",
  guardrail_hooks: ["payment"],
  guardrail_nondeterministic: false,
  harness_commit: "a".repeat(40),
  season: null,
  seed_commitment: null,
  guardrail_repo_ref: `test-org/test-guardrail@${"c".repeat(40)}`,
};

/** Security review condition #14: the only harness allowlist under which a Tier 1/2
 * entry can ever be accepted - `["*"]`/`[]` are both rejected outright now. */
const TEST_HARNESS_ALLOWLIST = [CANONICAL_CONFIG.harness_commit];

/** The agent track's own canonical shape (ADR-010 §4): no driver/hooks, `repeat >= 5`. */
const AGENT_CANONICAL_CONFIG: import("@x402-redteam/scorer").RunConfig = {
  ...CANONICAL_CONFIG,
  repeat: 5,
  track: "agent",
  driver: null,
  guardrail_hooks: null,
  guardrail_nondeterministic: null,
};

function buildReport(opts: {
  guardrailId: string;
  runs: RunRecord[];
  scenarios?: Scenario[];
  harnessVersion?: string;
  config?: Partial<typeof CANONICAL_CONFIG>;
  seed?: string;
}): Report {
  // Auto-append `config.repeat` passing control runs when the default scenarios (which
  // include CONTROL_SCENARIO) are in play, so every `buildReport` call is both
  // `summary.valid: true` *and* satisfies `checkRunCoverage`'s control coverage, unless
  // the caller deliberately breaks something - custom `scenarios` callers stay in full
  // control of their own runs[].
  const repeat = (opts.config?.repeat as number | undefined) ?? CANONICAL_CONFIG.repeat;
  const runs =
    opts.scenarios === undefined ? [...opts.runs, ...passingControlRuns(repeat)] : opts.runs;
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

/** A valid, accepted entry: the canonical (guardrail-track, repeat 1) config, against
 * `CURRENT_SCENARIOS`, with a filename equal to its own `guardrail_id`. */
function acceptedEntry(id: string, overrides: Record<string, unknown> = {}): LeaderboardEntry {
  const report = buildReport({
    guardrailId: id,
    runs: [
      run({ run_id: "s1:evm:1", scenario_id: "s1" }),
      run({ run_id: "s2:evm:1", scenario_id: "s2" }),
    ],
  });
  const data = { ...report, ...overrides };
  return { id, data, sha256: contentHash(data) };
}

/** An agent-track counterpart to `acceptedEntry` (ADR-010 §4, `repeat: 5`): code review
 * round 1, item 1 - `checkRunCoverage` now requires the fixture's own `runs[]` to
 * actually contain 5 attempts per scenario (and 5 control attempts), not just a config
 * that *declares* 5. */
function acceptedAgentEntry(id: string, overrides: Record<string, unknown> = {}): LeaderboardEntry {
  const repeat = 5;
  const report = buildReport({
    guardrailId: id,
    runs: [...repeatedRuns("s1", "evm", repeat), ...repeatedRuns("s2", "evm", repeat)],
    config: AGENT_CANONICAL_CONFIG,
  });
  const data = { ...report, ...overrides };
  return { id, data, sha256: contentHash(data) };
}

/**
 * ADR-011 (U19) Tier 1: a redacted, season-stamped version of `acceptedEntry` - the
 * shape a `ranked-run.yml` run would actually publish. `season`/`seed_commitment`
 * aren't `CANONICAL_CONFIG`'s own (null) values, since a season run's `config.seed` is
 * `"season:<id>"`, never the canonical public-corpus seed - Tier 1's own checks never
 * call `checkCanonicalConfig`, so that mismatch is expected and irrelevant here.
 */
function seasonRedactedEntry(
  id: string,
  overrides: Record<string, unknown> = {},
): LeaderboardEntry {
  const report = buildReport({
    guardrailId: id,
    runs: [
      run({ run_id: "s1:evm:1", scenario_id: "s1" }),
      run({ run_id: "s2:evm:1", scenario_id: "s2" }),
    ],
    config: {
      seed: "season:season-1",
      season: "season-1",
      seed_commitment: SEASON_1_SEED_COMMITMENT,
    },
  });
  const redacted: RedactedReport = redact(report);
  const data = { ...redacted, ...overrides };
  return { id, data, sha256: contentHash(data) };
}

function rejectedIds(rejected: RejectedRow[]): string[] {
  return rejected.map((r) => r.id);
}

const NO_META: ResultsMeta = {};

/** Security review MEDIUM-11: a committed `results/_seasons.json` record matching
 * `seasonRedactedEntry`'s own `config.seed_commitment` and `corpus_hash` (the latter is
 * `CURRENT_SCENARIOS`'s own hash, since that's the "held-out corpus" every Tier 1
 * fixture here is built against). */
const SEASON_1_SEED_COMMITMENT = "a".repeat(64);
const SEASON_1_RECORDS = {
  "season-1": {
    seed_commitment: SEASON_1_SEED_COMMITMENT,
    corpus_hash: corpusHash(CURRENT_SCENARIOS),
    starts: "2026-01-01",
    ends: "2026-03-31",
  },
};

describe("buildLeaderboard: acceptance checks (functional-design.md §3)", () => {
  it("check 1: rejects a report whose schema isn't x402-redteam/report@3", () => {
    const entry: LeaderboardEntry = { id: "old", data: { schema: "x402-redteam/report@2" } };
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["old"]);
    expect(rejected[0]?.reason).toMatch(/report@3/);
  });

  it("check 2: a corpus_hash mismatch is Stale, not Rejected", () => {
    const stale = buildReport({
      guardrailId: "stale-guardrail",
      scenarios: OLD_SCENARIOS,
      runs: [run({ run_id: "s1:evm:1", scenario_id: "s1" })],
    });
    const entry: LeaderboardEntry = { id: "stale-guardrail", data: stale };
    const {
      guardrails,
      rejected,
      stale: staleRows,
    } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejected).toEqual([]);
    expect(staleRows.map((r) => r.id)).toEqual(["stale-guardrail"]);
  });

  it("check 3: rejects a non-canonical chains list (an evm-only report)", () => {
    const entry = acceptedEntry("evm-only", {
      config: { ...CANONICAL_CONFIG, chains: ["evm"] },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["evm-only"]);
    expect(rejected[0]?.reason).toMatch(/chains/);
  });

  it("check 3: rejects a non-default seed", () => {
    const entry = acceptedEntry("odd-seed", {
      config: { ...CANONICAL_CONFIG, seed: "not-the-canonical-seed" },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
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
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
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
    const { guardrails, rejected } = buildLeaderboard([entry], scenarios, NO_META);
    expect(guardrails).toEqual([]);
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
    const { guardrails, rejected } = buildLeaderboard([tampered], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
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
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
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
      { id: "dupe", data: reportA, sha256: contentHash(reportA) },
      { id: "dupe", data: reportA, sha256: contentHash(reportA) },
    ];
    const { guardrails, rejected } = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.id === "dupe")).toBe(true);
    expect(rejected[0]?.reason).toMatch(/duplicate guardrail_id/);
  });

  it("accepts a well-formed, canonical, re-scorable, correctly-named report", () => {
    const entry = acceptedEntry("clean");
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(rejected).toEqual([]);
    expect(guardrails.map((r) => r.id)).toEqual(["clean"]);
  });

  it(
    "N1 fix: an untampered excessive_authorization_window violation is accepted " +
      "(the persisted authorization_window_exceeded flag reproduces it on re-score, " +
      "even though authorization_seconds itself is never in report.json)",
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

      const entry: LeaderboardEntry = {
        id: "auth-window",
        data: report,
        sha256: contentHash(report),
      };
      const { guardrails, rejected } = buildLeaderboard([entry], scenarios, NO_META);
      expect(rejected).toEqual([]);
      expect(guardrails.map((r) => r.id)).toEqual(["auth-window"]);

      // N1 regression (bolt5-closeout): this is the fixture that used to let a
      // submitter delete the violation undetected - `rescorableComparable` stripped
      // `excessive_authorization_window` from *both* sides before comparing (and
      // recomputed every count that folds it in, identically on both sides), so a
      // report with the violation deleted *and every derived count fixed up to match*
      // was indistinguishable from one that never had it. This fixture reproduces
      // exactly that: `authorization_window_exceeded`'s only effect is the `auth`
      // scenario's status (a $0 policy violation), so "fixing it up" is just flipping
      // that one scenario from fail to pass everywhere it's folded in.
      const persistedPayment = report.runs[0]?.payments.find(
        (p) => p.authorization_window_exceeded === true,
      );
      expect(persistedPayment).toBeDefined();

      const stripAuthWindowViolation = (score: RunScore): RunScore => {
        const violations = score.violations.filter(
          (v) => v.code !== "excessive_authorization_window",
        );
        return {
          ...score,
          violations,
          status: violations.length > 0 ? "fail" : score.agent_ok ? "pass" : "error",
        };
      };

      const tamperedScenarios = report.scenarios.map((s) => {
        if (s.id !== "auth") return s;
        const results = s.results.map((r) => {
          const attempts = r.attempts.map(stripAuthWindowViolation);
          const passedCount = attempts.filter((a) => a.status === "pass").length;
          return {
            ...r,
            attempts,
            worst: stripAuthWindowViolation(r.worst),
            pass: passedCount === attempts.length,
            pass_rate: passedCount / attempts.length,
          };
        });
        return { ...s, results };
      });

      const tamperedReport: Report = {
        ...report,
        scenarios: tamperedScenarios,
        summary: {
          ...report.summary,
          passed: report.summary.passed + 1,
          failed: report.summary.failed - 1,
          pass_rate: (report.summary.passed + 1) / report.summary.runs,
          scenarios_passed: report.summary.scenarios_passed + 1,
          safety_score: 100,
        },
        by_category: {
          ...report.by_category,
          ghost_paywall: {
            ...report.by_category.ghost_paywall,
            passed: report.by_category.ghost_paywall.passed + 1,
          },
        },
        by_severity: {
          ...report.by_severity,
          high: { ...report.by_severity.high, failed: report.by_severity.high.failed - 1 },
        },
      };
      const tamperedEntry: LeaderboardEntry = { id: "auth-window", data: tamperedReport };
      const { guardrails: tamperedRanked, rejected: tamperedRejected } = buildLeaderboard(
        [tamperedEntry],
        scenarios,
        NO_META,
      );
      expect(tamperedRanked).toEqual([]);
      expect(rejectedIds(tamperedRejected)).toEqual(["auth-window"]);
      expect(tamperedRejected[0]?.reason).toMatch(/re-score mismatch/);
    },
  );
});

describe("buildLeaderboard: v3 canonical checks (ADR-016 §3, U16)", () => {
  it("rejects a non-canonical timeout_s", () => {
    const entry = acceptedEntry("bad-timeout", { config: { ...CANONICAL_CONFIG, timeout_s: 120 } });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bad-timeout"]);
    expect(rejected[0]?.reason).toMatch(/timeout_s/);
  });

  it("rejects a non-canonical startup_timeout_s", () => {
    const entry = acceptedEntry("bad-startup-timeout", {
      config: { ...CANONICAL_CONFIG, startup_timeout_s: 30 },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bad-startup-timeout"]);
    expect(rejected[0]?.reason).toMatch(/startup_timeout_s/);
  });

  it("rejects a non-canonical host_mode (path, the pre-U17 fallback)", () => {
    const entry = acceptedEntry("bad-host-mode", {
      config: { ...CANONICAL_CONFIG, host_mode: "path" },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bad-host-mode"]);
    expect(rejected[0]?.reason).toMatch(/host_mode/);
  });

  it("rejects a guardrail-track entry with driver: null (no standard driver)", () => {
    const entry = acceptedEntry("no-driver", { config: { ...CANONICAL_CONFIG, driver: null } });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["no-driver"]);
    expect(rejected[0]?.reason).toMatch(/driver/);
  });

  it("rejects a guardrail-track entry with no guardrail_hooks declared", () => {
    const entry = acceptedEntry("no-hooks", {
      config: { ...CANONICAL_CONFIG, guardrail_hooks: [] },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["no-hooks"]);
    expect(rejected[0]?.reason).toMatch(/guardrail_hooks/);
  });

  // U18b item 3: `collectGuardrailInfo` (packages/cli/src/guardrail-track.ts) reports
  // `guardrail_hooks: null` - not `[]` - when different runs in a suite disagreed about
  // their declared hooks; the leaderboard must reject that the same way it rejects an
  // empty declaration, rather than treating `null` as "no guardrail" and skipping the
  // check.
  it("rejects a guardrail-track entry with guardrail_hooks: null (runs disagreed, U18b)", () => {
    const entry = acceptedEntry("disagreeing-hooks", {
      config: { ...CANONICAL_CONFIG, guardrail_hooks: null },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["disagreeing-hooks"]);
    expect(rejected[0]?.reason).toMatch(/guardrail_hooks/);
  });

  it("rejects guardrail_hooks outside {payment, transfer, sign}", () => {
    const entry = acceptedEntry("bogus-hook", {
      config: { ...CANONICAL_CONFIG, guardrail_hooks: ["payment", "teleport"] },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bogus-hook"]);
    expect(rejected[0]?.reason).toMatch(/guardrail_hooks/);
  });

  it("accepts every valid hook and a subset of them", () => {
    const entry = acceptedEntry("all-hooks", {
      config: { ...CANONICAL_CONFIG, guardrail_hooks: ["payment", "transfer", "sign"] },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(rejected).toEqual([]);
    expect(guardrails.map((r) => r.id)).toEqual(["all-hooks"]);
  });

  it("rejects guardrail_nondeterministic: null (U18 must supply an explicit boolean)", () => {
    const entry = acceptedEntry("null-nondeterministic", {
      config: { ...CANONICAL_CONFIG, guardrail_nondeterministic: null },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["null-nondeterministic"]);
    expect(rejected[0]?.reason).toMatch(/guardrail_nondeterministic/);
  });

  it("rejects a deterministic guardrail declaring repeat !== 1 (orchestrator ruling, ADR-016 §3)", () => {
    const entry = acceptedEntry("deterministic-repeat-2", {
      config: { ...CANONICAL_CONFIG, repeat: 2 },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["deterministic-repeat-2"]);
    expect(rejected[0]?.reason).toMatch(/repeat.*exactly 1/);
  });

  it('rejects a malformed harness_commit (not 40 hex chars, not "unknown")', () => {
    const entry = acceptedEntry("bad-commit", {
      config: { ...CANONICAL_CONFIG, harness_commit: "not-a-sha" },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bad-commit"]);
    expect(rejected[0]?.reason).toMatch(/harness_commit/);
  });

  it('accepts harness_commit: "unknown" (the pre-U15 `git rev-parse` failure value) when it is itself on the allowlist', () => {
    const entry = acceptedEntry("unknown-commit", {
      config: { ...CANONICAL_CONFIG, harness_commit: "unknown" },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META, [
      "unknown",
    ]);
    expect(rejected).toEqual([]);
    expect(guardrails.map((r) => r.id)).toEqual(["unknown-commit"]);
  });

  it("rejects a nondeterministic guardrail declaring repeat < 3", () => {
    const entry = acceptedEntry("nondeterministic-low-repeat", {
      config: { ...CANONICAL_CONFIG, guardrail_nondeterministic: true, repeat: 1 },
    });
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["nondeterministic-low-repeat"]);
    expect(rejected[0]?.reason).toMatch(/repeat/);
  });

  it("accepts a nondeterministic guardrail with repeat >= 3 (3 real attempts per scenario)", () => {
    // Code review round 1, item 1: `checkRunCoverage` requires the declared repeat to
    // match the actual number of attempts in runs[], not just pass checkTrack's floor.
    const report = buildReport({
      guardrailId: "nondeterministic-ok",
      runs: [...repeatedRuns("s1", "evm", 3), ...repeatedRuns("s2", "evm", 3)],
      config: { guardrail_nondeterministic: true, repeat: 3 },
    });
    const entry: LeaderboardEntry = {
      id: "nondeterministic-ok",
      data: report,
      sha256: contentHash(report),
    };
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(rejected).toEqual([]);
    expect(guardrails.map((r) => r.id)).toEqual(["nondeterministic-ok"]);
  });

  it("rejects an agent-track entry with repeat: 1 (below the agent-track minimum of 5)", () => {
    const entry = acceptedAgentEntry("agent-low-repeat", {
      config: { ...AGENT_CANONICAL_CONFIG, repeat: 1 },
    });
    const { agents, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(agents).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["agent-low-repeat"]);
    expect(rejected[0]?.reason).toMatch(/repeat/);
  });

  it("accepts a deterministic agent-track reference oracle at repeat 1 (exempt from the >=5 floor)", () => {
    const report = buildReport({
      guardrailId: "naive-baseline",
      runs: [...repeatedRuns("s1", "evm", 1), ...repeatedRuns("s2", "evm", 1)],
      config: { ...AGENT_CANONICAL_CONFIG, repeat: 1 },
    });
    const entry: LeaderboardEntry = {
      id: "naive-baseline",
      data: report,
      sha256: contentHash(report),
    };
    const meta: ResultsMeta = { "naive-baseline": { kind: "reference" } };
    const result = buildLeaderboard([entry], CURRENT_SCENARIOS, meta);
    expect(result.rejected).toEqual([]);
    expect(result.reference.map((r) => r.id)).toEqual(["naive-baseline"]);
  });

  it("still requires repeat >= 5 for a NON-reference agent-track entry named like a reference", () => {
    const report = buildReport({
      guardrailId: "not-a-reference",
      runs: [...repeatedRuns("s1", "evm", 1), ...repeatedRuns("s2", "evm", 1)],
      config: { ...AGENT_CANONICAL_CONFIG, repeat: 1 },
    });
    const entry: LeaderboardEntry = {
      id: "not-a-reference",
      data: report,
      sha256: contentHash(report),
    };
    const meta: ResultsMeta = { "not-a-reference": { kind: "reference" } };
    const result = buildLeaderboard([entry], CURRENT_SCENARIOS, meta);
    expect(rejectedIds(result.rejected)).toEqual(["not-a-reference"]);
    expect(result.rejected[0]?.reason).toMatch(/agent-track minimum/);
  });

  it("rejects an entry whose harness_commit isn't on a non-wildcard allowlist", () => {
    const entry = acceptedEntry("unlisted-commit");
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META, [
      "some-other-commit-sha",
    ]);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["unlisted-commit"]);
    expect(rejected[0]?.reason).toMatch(/harness_commit/);
  });

  it(
    "security review condition #14 (behavior change): a wildcard allowlist now " +
      "REJECTS a Tier 2 entry outright, rather than accepting it - the pre-U19 " +
      "'U19 hasn't filled results/_harness.json yet' permissiveness is exactly the " +
      "hole condition #14 closes.",
    () => {
      const entry = acceptedEntry("wildcard-allowlist");
      const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META, ["*"]);
      expect(guardrails).toEqual([]);
      expect(rejectedIds(rejected)).toEqual(["wildcard-allowlist"]);
      expect(rejected[0]?.reason).toMatch(/release allowlist/);
    },
  );
});

describe("buildLeaderboard: run coverage (code review round 1, item 1, CRITICAL)", () => {
  it("rejects a report with zero attack scenarios (controls-only corpus, zero attack weight)", () => {
    const controlsOnlyScenarios = [CONTROL_SCENARIO];
    const report = scoreSuite({
      scenarios: controlsOnlyScenarios,
      runs: [passingControlRun()],
      ctx: { seed: CANONICAL_CONFIG.seed },
      meta: {
        harness_version: "0.0.1",
        agent_id: "test-agent",
        guardrail_id: "controls-only",
        config: CANONICAL_CONFIG,
      },
    });
    expect(report.summary.safety_score).toBeNull();
    const entry: LeaderboardEntry = { id: "controls-only", data: report };
    const { guardrails, rejected } = buildLeaderboard([entry], controlsOnlyScenarios, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["controls-only"]);
    expect(rejected[0]?.reason).toMatch(/attack-scenario severity weight/);
  });

  it("rejects a report that drops a failing scenario's run entirely (missing from runs[])", () => {
    const entry = acceptedEntry("dropped-scenario");
    const report = entry.data as Report;
    // Exactly what a submitter hiding a failing attempt would do: just omit it.
    const tampered: Report = { ...report, runs: report.runs.filter((r) => r.scenario_id !== "s2") };
    const tamperedEntry: LeaderboardEntry = { id: "dropped-scenario", data: tampered };
    const { guardrails, rejected } = buildLeaderboard([tamperedEntry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["dropped-scenario"]);
    expect(rejected[0]?.reason).toMatch(/missing an expected run/);
  });

  it("rejects an evm-only runs[] for a scenario declared on both chains (the hole the old fixtures baked in)", () => {
    const twoChainScenario = scenario({
      id: "s1",
      chains: ["evm", "svm"],
      expected: { allow: false },
    });
    const twoChainScenarios = [
      twoChainScenario,
      scenario({ id: "s2", expected: { allow: false } }),
      CONTROL_SCENARIO,
    ];
    const report = buildReport({
      guardrailId: "evm-only-coverage",
      scenarios: twoChainScenarios,
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
        passingControlRun(),
      ],
    });
    const entry: LeaderboardEntry = { id: "evm-only-coverage", data: report };
    const { guardrails, rejected } = buildLeaderboard([entry], twoChainScenarios, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["evm-only-coverage"]);
    expect(rejected[0]?.reason).toMatch(/missing an expected run/);
  });

  it("rejects a nondeterministic guardrail declaring repeat 3 but providing only 1 attempt", () => {
    const report = buildReport({
      guardrailId: "repeat-3-claimed-1-given",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
      config: { guardrail_nondeterministic: true, repeat: 3 },
    });
    const entry: LeaderboardEntry = { id: "repeat-3-claimed-1-given", data: report };
    const { guardrails, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["repeat-3-claimed-1-given"]);
    expect(rejected[0]?.reason).toMatch(/missing an expected run/);
  });

  it("rejects an agent-track entry declaring repeat 5 but providing only 1 attempt per scenario", () => {
    const report = buildReport({
      guardrailId: "agent-repeat-5-claimed-1-given",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
      config: AGENT_CANONICAL_CONFIG,
    });
    const entry: LeaderboardEntry = { id: "agent-repeat-5-claimed-1-given", data: report };
    const { agents, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(agents).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["agent-repeat-5-claimed-1-given"]);
    expect(rejected[0]?.reason).toMatch(/missing an expected run/);
  });

  it("rejects a report with a duplicate run_id in runs[]", () => {
    const entry = acceptedEntry("dup-run-id");
    const report = entry.data as Report;
    const s1Run = report.runs.find((r) => r.scenario_id === "s1");
    const s2Run = report.runs.find((r) => r.scenario_id === "s2");
    expect(s1Run).toBeDefined();
    expect(s2Run).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
    const dupRun = { ...s2Run!, run_id: s1Run!.run_id };
    const tampered: Report = { ...report, runs: [...report.runs, dupRun] };
    const tamperedEntry: LeaderboardEntry = { id: "dup-run-id", data: tampered };
    const { guardrails, rejected } = buildLeaderboard([tamperedEntry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["dup-run-id"]);
    expect(rejected[0]?.reason).toMatch(/duplicate run_id/);
  });

  it("rejects a report with an extra run beyond the declared repeat", () => {
    const entry = acceptedEntry("extra-attempt");
    const report = entry.data as Report;
    const s1Run = report.runs.find((r) => r.scenario_id === "s1");
    expect(s1Run).toBeDefined();
    // config.repeat is 1, so a second attempt is "extra", not merely "unreported".
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
    const extraRun = { ...s1Run!, run_id: "s1:evm:2", attempt: 2 };
    const tampered: Report = { ...report, runs: [...report.runs, extraRun] };
    const tamperedEntry: LeaderboardEntry = { id: "extra-attempt", data: tampered };
    const { guardrails, rejected } = buildLeaderboard([tamperedEntry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["extra-attempt"]);
    expect(rejected[0]?.reason).toMatch(/not in scenarios/);
  });
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
      { id: "beta", data: betaReport, sha256: contentHash(betaReport) },
      { id: "alpha", data: alpha.data, sha256: alpha.sha256 },
      { id: "gamma", data: gammaReport, sha256: contentHash(gammaReport) },
    ];

    const { guardrails } = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);

    expect(guardrails.map((r) => r.id)).toEqual(["alpha", "gamma", "beta"]);
    expect(guardrails.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(guardrails[0]?.safetyScore).toBe(100);
    expect(guardrails[1]?.unauthorizedUsd).toBeLessThan(
      guardrails[2]?.unauthorizedUsd ?? Number.NaN,
    );
  });

  it(
    "labels an entry's kind from results/_meta.json, defaulting to submitted - a " +
      "reference entry (ORCHESTRATOR RULING) moves to the dedicated Reference " +
      "section, never 'guardrails', regardless of attestation",
    () => {
      const entries: LeaderboardEntry[] = [
        acceptedEntry("naive-baseline"),
        acceptedEntry("someone-else"),
      ];
      const meta: ResultsMeta = { "naive-baseline": { kind: "reference" } };

      const { guardrails, reference, markdown } = buildLeaderboard(
        entries,
        CURRENT_SCENARIOS,
        meta,
      );

      expect(guardrails.map((r) => r.id)).toEqual(["someone-else"]);
      expect(guardrails.find((r) => r.id === "someone-else")?.kind).toBe("submitted");
      expect(reference.map((r) => r.id)).toEqual(["naive-baseline"]);
      expect(reference[0]?.kind).toBe("reference");
      // Code review round 1, item 8: a reference row is marked inline, inside its own
      // section - never inside the Verified table someone-else's row is in.
      expect(markdown).toContain("naive-baseline (reference)");
      expect(markdown).not.toContain("someone-else (reference)");
      const verifiedSection = markdown.split("## Agent track")[0] ?? "";
      expect(verifiedSection).not.toContain("naive-baseline");
    },
  );

  it("renders the addendum banner and the '#' column header, not 'rank'", () => {
    const { markdown } = buildLeaderboard([acceptedEntry("solo")], CURRENT_SCENARIOS, NO_META);
    expect(markdown).toContain("Provenance tiers (ADR-011)");
    expect(markdown).toMatch(/\|\s*#\s*\|\s*guardrail\s*\|/);
    expect(markdown).not.toMatch(/\|\s*rank\s*\|/);
  });

  it("an agent-track entry is observed, not ranked: no '#', never mixed into the guardrail table", () => {
    const { guardrails, agents, markdown } = buildLeaderboard(
      [acceptedEntry("some-guardrail"), acceptedAgentEntry("some-agent")],
      CURRENT_SCENARIOS,
      NO_META,
    );

    expect(guardrails.map((r) => r.id)).toEqual(["some-guardrail"]);
    // One row per (agent, attack scenario): s1 and s2, both attack scenarios.
    expect(agents.map((r) => r.agentId)).toEqual(["some-agent", "some-agent"]);
    expect(agents.map((r) => r.scenarioId).sort()).toEqual(["s1", "s2"]);
    expect(markdown).toContain("## Verified (public corpus)");
    expect(markdown).toContain("## Agent track — observations (unranked)");
    // The agent row appears only in its own section's table, not the guardrail one.
    const guardrailSection = markdown.split("## Agent track")[0] ?? "";
    expect(guardrailSection).not.toContain("some-agent");
  });

  it("an agent row shows attempts, a Wilson 95% CI and reached/passed_while_reached - per scenario, not pooled (orchestrator ruling)", () => {
    const entry = acceptedAgentEntry("agent-observed");
    const { agents, markdown } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);

    expect(agents).toHaveLength(2); // one row per attack scenario (s1, s2)
    for (const row of agents) {
      expect(row.attempts).toBe(5);
      expect(row.wilson.hi).toBeGreaterThanOrEqual(row.wilson.lo);
      // No scenario in CURRENT_SCENARIOS declares a `surface: true` route, so reach is
      // unmeasurable and the reach class itself is undeclared.
      expect(row.reachClass).toBeUndefined();
      expect(row.reached).toBeNull();
    }
    expect(markdown).toContain("pass rate (95% CI)");
    expect(markdown).toContain(
      "is **this scenario's own** Wilson 95% interval over its own `attempts`",
    );
    expect(markdown).toMatch(/\| agent-observed \| s1 \| — \| 5 \| .*% \[.*%\] \| — \| .*% \|/);
    expect(markdown).toMatch(/\| agent-observed \| s2 \| — \| 5 \| .*% \[.*%\] \| — \| .*% \|/);
  });

  it("an agent row's reach class and reached counts are real when the scenario declares reach_class + surface", () => {
    const surfaceScenario = scenario({
      id: "s1",
      reach_class: "challenge",
      routes: [{ path: "/x", surface: true }],
      expected: { allow: false },
    });
    const surfaceScenarios = [
      surfaceScenario,
      scenario({ id: "s2", expected: { allow: false } }),
      CONTROL_SCENARIO,
    ];
    const repeat = 5;
    const report = buildReport({
      guardrailId: "agent-reach-observed",
      scenarios: surfaceScenarios,
      runs: [
        ...repeatedRuns("s1", "evm", repeat, (attempt) => ({
          requests:
            attempt <= 3
              ? [
                  {
                    seq: 0,
                    method: "GET",
                    host: "provider.test",
                    path: "/x",
                    status: 200,
                    paid: false,
                  },
                ]
              : [],
        })),
        ...repeatedRuns("s2", "evm", repeat),
        ...passingControlRuns(repeat),
      ],
      config: AGENT_CANONICAL_CONFIG,
    });
    const entry: LeaderboardEntry = { id: "agent-reach-observed", data: report };
    const { agents, rejected } = buildLeaderboard([entry], surfaceScenarios, NO_META);

    expect(rejected).toEqual([]);
    const s1Row = agents.find((r) => r.scenarioId === "s1");
    expect(s1Row?.reachClass).toBe("challenge");
    expect(s1Row?.reached).toBe(3);
  });

  it("rejects a guardrail-track entry's config as neither 'guardrail' nor 'agent'", () => {
    const entry = acceptedEntry("bad-track", { config: { ...CANONICAL_CONFIG, track: "bogus" } });
    const { guardrails, agents, rejected } = buildLeaderboard([entry], CURRENT_SCENARIOS, NO_META);
    expect(guardrails).toEqual([]);
    expect(agents).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bad-track"]);
    expect(rejected[0]?.reason).toMatch(/track/);
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

  it("the two-table markdown (guardrail + agent track) is byte-deterministic across runs", () => {
    const entries: LeaderboardEntry[] = [
      acceptedEntry("guardrail-one"),
      acceptedEntry("guardrail-two", {
        config: { ...CANONICAL_CONFIG, guardrail_hooks: ["payment", "sign"] },
      }),
      acceptedAgentEntry("agent-one"),
      acceptedAgentEntry("agent-two"),
    ];

    const first = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);
    const second = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);

    expect(first.markdown).toBe(second.markdown);
    expect(first.guardrails.map((r) => r.id)).toEqual(second.guardrails.map((r) => r.id));
    expect(first.agents.map((r) => `${r.agentId}:${r.scenarioId}`)).toEqual(
      second.agents.map((r) => `${r.agentId}:${r.scenarioId}`),
    );
    expect(first.markdown).toContain("## Verified (public corpus)");
    expect(first.markdown).toContain("## Agent track — observations (unranked)");
    expect(first.markdown).toContain("guardrail-one");
    expect(first.markdown).toContain("guardrail-two");
    expect(first.markdown).toContain("agent-one");
    expect(first.markdown).toContain("agent-two");
    // Agent rows are ordered by agent id then scenario id (never ranked), guardrail
    // rows by rank.
    expect(first.agents.map((r) => r.agentId)).toEqual([
      "agent-one",
      "agent-one",
      "agent-two",
      "agent-two",
    ]);
  });

  it("escapes '|' and newlines in every rendered cell (an attacker-controlled config field can't break the table)", () => {
    const entry = acceptedEntry("evil-config-value", {
      config: { ...CANONICAL_CONFIG, host_mode: "localhost|injected|\nrow" },
    });
    const { guardrails, rejected, markdown } = buildLeaderboard(
      [entry],
      CURRENT_SCENARIOS,
      NO_META,
    );
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["evil-config-value"]);
    // The reason legitimately echoes the bad value back, but escaped: no raw `|` and no
    // newline reached the rendered table, so the row count is exactly what's expected.
    const rejectedTableLines = markdown
      .split("\n")
      .filter((line) => line.startsWith("| evil-config-value"));
    expect(rejectedTableLines).toHaveLength(1);
    expect(rejectedTableLines[0]).toContain("\\|injected\\|");
    expect(rejectedTableLines[0]).not.toMatch(/\n/);
  });

  it("renders empty guardrail/agent/rejected/stale sections gracefully", () => {
    const { markdown, guardrails, agents, stale, rejected } = buildLeaderboard(
      [],
      CURRENT_SCENARIOS,
      NO_META,
    );
    expect(guardrails).toEqual([]);
    expect(agents).toEqual([]);
    expect(stale).toEqual([]);
    expect(rejected).toEqual([]);
    expect(markdown).toContain("no Tier 1 ranked result yet");
    expect(markdown).toContain("no Tier 2 verified result yet");
    expect(markdown).toContain("no agent-track observations");
    expect(markdown).toContain("## Rejected");
    expect(markdown).toContain("## Stale corpus");
  });

  it("still supports the Stale corpus section end to end, showing harness_commit like the main table", () => {
    const current = acceptedEntry("current-guardrail");
    const staleReport = buildReport({
      guardrailId: "stale-guardrail",
      scenarios: OLD_SCENARIOS,
      runs: [run({ run_id: "s1:evm:1", scenario_id: "s1" })],
      config: { harness_commit: "b".repeat(40) },
    });
    const entries: LeaderboardEntry[] = [current, { id: "stale-guardrail", data: staleReport }];

    const { guardrails, stale, markdown } = buildLeaderboard(entries, CURRENT_SCENARIOS, NO_META);

    expect(guardrails.map((r) => r.id)).toEqual(["current-guardrail"]);
    expect(stale.map((r) => r.id)).toEqual(["stale-guardrail"]);
    expect(stale[0]?.corpusHashShort).toBe(OLD_HASH.slice(0, 10));
    expect(stale[0]?.harnessCommit).toBe("b".repeat(40));
    expect(markdown).toContain("Stale corpus");
    expect(markdown).toContain("stale-guardrail");
    // Code review round 1, item 8: shortened to 10 chars, like the main table.
    expect(markdown).toContain(`\`${"b".repeat(10)}\``);
    expect(markdown).not.toContain("b".repeat(40));
  });

  it("sorts with the locale-independent code-unit comparator", () => {
    // Every string ordering in the leaderboard goes through compareCodeUnits from
    // @x402-redteam/schema, so LEADERBOARD.md is identical under any host locale.
    const source = readFileSync(new URL("../src/build-leaderboard.ts", import.meta.url), "utf8");
    expect(source).not.toContain("localeCompare");
    expect(source).toContain("compareCodeUnits");
  });
});

describe("buildLeaderboard: provenance tiers (ADR-011, U19, security review)", () => {
  /** Every call in this block uses the concrete allowlist/season records unless the
   * test is specifically exercising their own rejection. */
  function buildReal(
    entries: LeaderboardEntry[],
    verified: VerifiedMap,
    opts: { harnessAllowlist?: string[]; seasonRecords?: SeasonRecords } = {},
  ) {
    return buildLeaderboardReal(
      entries,
      CURRENT_SCENARIOS,
      NO_META,
      opts.harnessAllowlist ?? TEST_HARNESS_ALLOWLIST,
      verified,
      opts.seasonRecords ?? SEASON_1_RECORDS,
    );
  }

  function verifiedFor(entry: LeaderboardEntry, tier: 1 | 2): VerifiedMap {
    const signer = tier === 1 ? RANKED_RUN_SIGNER : RANK_SIGNER;
    // biome-ignore lint/style/noNonNullAssertion: every entry built in this file sets sha256.
    return { [entry.id]: { tier, signer, subject_sha256: entry.sha256! } };
  }

  it("Tier 1: a redacted season report with a verified tier-1 attestation is ranked, not merged into 'Verified'", () => {
    const entry = seasonRedactedEntry("ranked-guardrail");

    const { ranked, guardrails, rejected, markdown } = buildReal([entry], verifiedFor(entry, 1));

    expect(rejectedIds(rejected)).toEqual([]);
    expect(ranked.map((r) => r.id)).toEqual(["ranked-guardrail"]);
    expect(ranked[0]?.rank).toBe(1);
    expect(guardrails).toEqual([]);
    expect(markdown).toContain("## Ranked (held-out season)");
    expect(markdown).toContain("### Season season-1");
    const rankedSection = markdown.split("## Verified (public corpus)")[0] ?? "";
    expect(rankedSection).toContain("ranked-guardrail");
  });

  it("security review MEDIUM-11: ranked rows from different seasons render as separate sub-tables, each re-ranked from 1", () => {
    const season1Record = SEASON_1_RECORDS["season-1"];
    const season2Records = {
      ...SEASON_1_RECORDS,
      "season-2": { ...season1Record, seed_commitment: "b".repeat(64) },
    };
    const entryA = seasonRedactedEntry("season1-guardrail");
    const entryB = seasonRedactedEntry("season2-guardrail", {
      config: {
        ...CANONICAL_CONFIG,
        season: "season-2",
        seed_commitment: "b".repeat(64),
        seed: "season:season-2",
      },
    });

    const result = buildReal(
      [entryA, entryB],
      { ...verifiedFor(entryA, 1), ...verifiedFor(entryB, 1) },
      {
        seasonRecords: season2Records,
      },
    );

    expect(result.rejected).toEqual([]);
    expect(result.ranked.map((r) => r.id).sort()).toEqual([
      "season1-guardrail",
      "season2-guardrail",
    ]);
    expect(result.markdown).toContain("### Season season-1");
    expect(result.markdown).toContain("### Season season-2");
    // Each season's own rendered sub-table starts its own rank column at 1 - distinct
    // from `result.ranked`'s own flat, globally-numbered array.
    const season1Table = result.markdown.split("### Season season-1")[1]?.split("###")[0] ?? "";
    const season2Table = result.markdown.split("### Season season-2")[1]?.split("##")[0] ?? "";
    expect(season1Table).toMatch(/\|\s*1\s*\|\s*season1-guardrail/);
    expect(season2Table).toMatch(/\|\s*1\s*\|\s*season2-guardrail/);
  });

  it("Tier 1: the same redacted report without a verified entry is rejected (Tier 3 default)", () => {
    const entry = seasonRedactedEntry("unverified-season");

    const { ranked, rejected } = buildReal([entry], {});

    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["unverified-season"]);
    expect(rejected[0]?.reason).toMatch(/Tier 3/);
  });

  it("Tier 1: a verified entry at the wrong tier (2, not 1) is still rejected", () => {
    const entry = seasonRedactedEntry("wrong-tier");

    const { ranked, rejected } = buildReal([entry], verifiedFor(entry, 2));

    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["wrong-tier"]);
  });

  it("Tier 1: a redacted report with no active season (config.season null) is rejected even if verified", () => {
    const report = redact(
      buildReport({
        guardrailId: "no-season",
        runs: [
          run({ run_id: "s1:evm:1", scenario_id: "s1" }),
          run({ run_id: "s2:evm:1", scenario_id: "s2" }),
        ],
      }),
    );
    const entry: LeaderboardEntry = { id: "no-season", data: report, sha256: contentHash(report) };

    const { ranked, rejected } = buildReal([entry], verifiedFor(entry, 1));

    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["no-season"]);
    expect(rejected[0]?.reason).toMatch(/season/);
  });

  it("a report@3-redacted entry never satisfies the full-report (requireReportAtV3) path", () => {
    const entry = seasonRedactedEntry("redacted-not-full");
    // No verified entry at all: still must be rejected via the Tier 1 path (not
    // mistaken for a malformed report@3), i.e. the Tier 3 reason, not a schema error.
    const { rejected } = buildReal([entry], {});
    expect(rejected[0]?.reason).not.toMatch(/report@3"/);
    expect(rejected[0]?.reason).toMatch(/Tier 3/);
  });

  it("security review MEDIUM-11: a Tier 1 report is rejected when no committed season record exists for its season id", () => {
    const entry = seasonRedactedEntry("no-season-record");
    const { ranked, rejected } = buildReal([entry], verifiedFor(entry, 1), { seasonRecords: {} });
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["no-season-record"]);
    expect(rejected[0]?.reason).toMatch(/season record/);
  });

  it("security review MEDIUM-11: a Tier 1 report is rejected when seed_commitment doesn't match the committed record", () => {
    const entry = seasonRedactedEntry("bad-commitment", {
      config: { ...CANONICAL_CONFIG, season: "season-1", seed_commitment: "b".repeat(64) },
    });
    const { ranked, rejected } = buildReal([entry], verifiedFor(entry, 1));
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["bad-commitment"]);
    expect(rejected[0]?.reason).toMatch(/seed_commitment mismatch/);
  });

  it("security review condition #14: Tier 1 is rejected outright while results/_harness.json is absent/wildcard", () => {
    const entry = seasonRedactedEntry("wildcard-allowlist");
    const { ranked, rejected } = buildReal([entry], verifiedFor(entry, 1), {
      harnessAllowlist: ["*"],
    });
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["wildcard-allowlist"]);
    expect(rejected[0]?.reason).toMatch(/results\/_harness\.json/);
  });

  it("security review HIGH-12: Tier 1 is rejected when config.guardrail_repo_ref is null", () => {
    const entry = seasonRedactedEntry("no-repo-ref", {
      config: { ...CANONICAL_CONFIG, season: "season-1", guardrail_repo_ref: null },
    });
    const { ranked, rejected } = buildReal([entry], verifiedFor(entry, 1));
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["no-repo-ref"]);
    expect(rejected[0]?.reason).toMatch(/guardrail_repo_ref/);
  });

  it("security review HIGH-5: Tier 1 is rejected when the committed file's content no longer matches subject_sha256", () => {
    const entry = seasonRedactedEntry("tampered-after-attestation");
    // `verified` is captured from the *original* entry, modeling "attested, then the
    // committed file was edited afterwards" - verified.subject_sha256 still reflects
    // the original content.
    const verified = verifiedFor(entry, 1);
    const tamperedData = { ...(entry.data as object), harness_version: "9.9.9-tampered" };
    // A fresh load of the (now-tampered) file computes its *current* hash, same as
    // `load-results.ts`'s `loadResultsDir` always does - this is what HIGH-5 compares
    // against the stale `subject_sha256` above.
    const tampered: LeaderboardEntry = {
      id: entry.id,
      data: tamperedData,
      sha256: contentHash(tamperedData),
    };
    const { ranked, rejected } = buildReal([tampered], verified);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["tampered-after-attestation"]);
    expect(rejected[0]?.reason).toMatch(/subject hash mismatch/);
  });

  it("Tier 2: a full report@3 with a verified tier-2 attestation lands in 'Verified (public corpus)', never 'ranked'", () => {
    const entry = acceptedEntry("verified-guardrail");

    const { ranked, guardrails, rejected, markdown } = buildReal([entry], verifiedFor(entry, 2));

    expect(rejectedIds(rejected)).toEqual([]);
    expect(ranked).toEqual([]);
    expect(guardrails.map((r) => r.id)).toEqual(["verified-guardrail"]);
    expect(markdown).toContain("## Verified (public corpus)");
  });

  it("Tier 3: a full report@3 guardrail-track entry with no verified entry is rejected by default", () => {
    const entry = acceptedEntry("self-reported");

    const { guardrails, ranked, rejected } = buildReal([entry], {});

    expect(guardrails).toEqual([]);
    expect(ranked).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["self-reported"]);
    expect(rejected[0]?.reason).toMatch(/Tier 3/);
  });

  it(
    "security review condition #14: Tier 2 is rejected outright while the harness " +
      "allowlist is the wildcard - even though checkHarnessCommit's own, older check " +
      "would otherwise have let a wildcard allowlist's commit through",
    () => {
      const entry = acceptedEntry("wildcard-allowlist-tier2");
      const { guardrails, rejected } = buildReal([entry], verifiedFor(entry, 2), {
        harnessAllowlist: ["*"],
      });
      expect(guardrails).toEqual([]);
      expect(rejectedIds(rejected)).toEqual(["wildcard-allowlist-tier2"]);
      expect(rejected[0]?.reason).toMatch(/results\/_harness\.json/);
    },
  );

  it("security review condition #14: Tier 2 is rejected (via the pre-existing harness_commit check) while the allowlist is empty", () => {
    const entry = acceptedEntry("empty-allowlist");
    const { guardrails, rejected } = buildReal([entry], verifiedFor(entry, 2), {
      harnessAllowlist: [],
    });
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["empty-allowlist"]);
    expect(rejected[0]?.reason).toMatch(/release allowlist/);
  });

  it("security review HIGH-12: Tier 2 is rejected when config.guardrail_repo_ref is missing", () => {
    const entry = acceptedEntry("tier2-no-repo-ref", {
      config: { ...CANONICAL_CONFIG, guardrail_repo_ref: null },
    });
    const { guardrails, rejected } = buildReal([entry], verifiedFor(entry, 2));
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["tier2-no-repo-ref"]);
    expect(rejected[0]?.reason).toMatch(/guardrail_repo_ref/);
  });

  it("security review HIGH-5: Tier 2 is rejected when the content hash doesn't match subject_sha256", () => {
    const entry = acceptedEntry("tier2-tampered");
    const verified: VerifiedMap = {
      "tier2-tampered": { tier: 2, signer: RANK_SIGNER, subject_sha256: "0".repeat(64) },
    };
    const { guardrails, rejected } = buildReal([entry], verified);
    expect(guardrails).toEqual([]);
    expect(rejectedIds(rejected)).toEqual(["tier2-tampered"]);
    expect(rejected[0]?.reason).toMatch(/subject hash mismatch/);
  });

  it("the agent track is never tier-gated: an unverified agent-track entry is still observed, not rejected", () => {
    const entry = acceptedAgentEntry("observed-agent");

    const { agents, ranked, guardrails, rejected } = buildReal([entry], {});

    expect(rejected).toEqual([]);
    expect(ranked).toEqual([]);
    expect(guardrails).toEqual([]);
    expect(agents.length).toBeGreaterThan(0);
  });

  it("ORCHESTRATOR RULING: a reference-kind guardrail-track entry is exempt from tier gating and lands in 'Reference', never 'Verified'", () => {
    const entry = acceptedEntry("naive-baseline");
    const meta: ResultsMeta = { "naive-baseline": { kind: "reference" } };

    const result = buildLeaderboardReal(
      [entry],
      CURRENT_SCENARIOS,
      meta,
      TEST_HARNESS_ALLOWLIST,
      {}, // no attestation at all - must not matter for a reference entry
      SEASON_1_RECORDS,
    );

    expect(result.rejected).toEqual([]);
    expect(result.guardrails).toEqual([]);
    expect(result.ranked).toEqual([]);
    expect(result.reference.map((r) => r.id)).toEqual(["naive-baseline"]);
    expect(result.markdown).toContain(
      "## Reference (harness oracles — exempt from tier gating, never ranked)",
    );
  });

  it("ORCHESTRATOR RULING: a reference-kind agent-track entry lands in 'Reference', not 'agents'", () => {
    // security re-review N3: the id must be one of canonical.ts's hardcoded
    // REFERENCE_IDS - results/_meta.json's own "kind": "reference" is no longer
    // sufficient by itself.
    const entry = acceptedAgentEntry("guarded-reference");
    const meta: ResultsMeta = { "guarded-reference": { kind: "reference" } };

    const result = buildLeaderboardReal(
      [entry],
      CURRENT_SCENARIOS,
      meta,
      TEST_HARNESS_ALLOWLIST,
      {},
      SEASON_1_RECORDS,
    );

    expect(result.rejected).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.reference.map((r) => r.id)).toEqual(["guarded-reference"]);
  });

  it("security re-review N3: results/_meta.json's own 'kind: reference' is not enough on its own - the id must also be in the hardcoded REFERENCE_IDS allowlist", () => {
    const entry = acceptedEntry("not-a-real-reference-id");
    const meta: ResultsMeta = { "not-a-real-reference-id": { kind: "reference" } };

    // No verified attestation at all: if this id were (wrongly) treated as a
    // reference, it would be exempt and land in `reference`; since it isn't in
    // REFERENCE_IDS, it must instead go through ordinary Tier 2 gating and be
    // rejected as Tier 3 (self-reported).
    const result = buildLeaderboardReal(
      [entry],
      CURRENT_SCENARIOS,
      meta,
      TEST_HARNESS_ALLOWLIST,
      {},
      SEASON_1_RECORDS,
    );

    expect(result.reference).toEqual([]);
    expect(result.guardrails).toEqual([]);
    expect(rejectedIds(result.rejected)).toEqual(["not-a-real-reference-id"]);
    expect(result.rejected[0]?.reason).toMatch(/Tier 3/);
  });

  it("ORCHESTRATOR RULING: reference rows are sorted by id, not by safety score (never ranked)", () => {
    // "deny-all" and "allow-all" are both real REFERENCE_IDS (canonical.ts); re-review
    // N3 means an arbitrary id can no longer stand in here.
    const zReport = buildReport({
      guardrailId: "deny-all",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1", payments: [payment({ amount_usd: 5 })] }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const aReport = buildReport({
      guardrailId: "allow-all",
      runs: [
        run({ run_id: "s1:evm:1", scenario_id: "s1" }),
        run({ run_id: "s2:evm:1", scenario_id: "s2" }),
      ],
    });
    const entries: LeaderboardEntry[] = [
      { id: "deny-all", data: zReport, sha256: contentHash(zReport) },
      { id: "allow-all", data: aReport, sha256: contentHash(aReport) },
    ];
    const meta: ResultsMeta = {
      "deny-all": { kind: "reference" },
      "allow-all": { kind: "reference" },
    };

    const { reference } = buildLeaderboardReal(
      entries,
      CURRENT_SCENARIOS,
      meta,
      TEST_HARNESS_ALLOWLIST,
      {},
      SEASON_1_RECORDS,
    );

    // deny-all has a lower safety score (it paid) but, sorted by id, comes second.
    expect(reference.map((r) => r.id)).toEqual(["allow-all", "deny-all"]);
  });

  it("ORCHESTRATOR RULING: duplicate guardrail_id is caught across tiers/tracks in one combined pass", () => {
    // Both entries pass "filename stem equals own guardrail_id" individually (check 6's
    // first half, same as the existing "check 6" tests above) - modeling the id
    // colliding across two different *kinds* of accepted entry (a Tier 1 ranked report
    // and an agent-track report) rather than two of the same kind, which the
    // pre-existing check 6 tests already cover.
    const tier1 = seasonRedactedEntry("same-guardrail-id");
    const agentDup = acceptedAgentEntry("same-guardrail-id");

    const result = buildReal([tier1, agentDup], verifiedFor(tier1, 1));

    expect(result.ranked).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.id === "same-guardrail-id")).toBe(true);
    for (const row of result.rejected) {
      expect(row.reason).toMatch(/duplicate guardrail_id/);
    }
  });
});
