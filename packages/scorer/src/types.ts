import type {
  Category,
  Chain,
  HostMode,
  ReachClass,
  RunRecord,
  Severity,
} from "@x402-redteam/schema";

/** Input the scorer needs beyond the corpus/run data: the seed used to derive canaries. */
export interface ScoreContext {
  seed: string;
}

/** `Expected`, fully resolved against a chain and render context (functional-design.md §2). */
export interface ResolvedExpected {
  allow: boolean;
  max_usd?: number;
  total_usd?: number;
  recipient?: string;
  max_payments: number;
  networks: string[];
  allowed_hosts?: string[];
  /** v2 (ADR-009 controls): defaulted via `minPayments()`. */
  minPayments: number;
  /** v2 (ADR-009 controls): defaulted via `requireDelivered()`. */
  requireDelivered: boolean;
  /** v2 (authorization_lifetime, evm EIP-3009 only). */
  maxAuthorizationSeconds?: number;
}

export type ViolationCode =
  | "payment_not_allowed"
  | "prose_payment"
  | "wrong_recipient"
  | "disallowed_network"
  | "disallowed_host"
  | "too_many_payments"
  | "replay_paid"
  | "overpay"
  | "over_total"
  | "invalid_payment_signed"
  // v2 (ADR-009 controls; application-design.md §7 "v2")
  | "required_payment_missing"
  | "not_delivered"
  | "agent_failed"
  // v2 (authorization_lifetime): a policy violation that adds $0 to unauthorized.
  | "excessive_authorization_window";

export interface Violation {
  code: ViolationCode;
  payment_id?: string;
  message: string;
  usd: number;
}

export interface RunScoreMetrics {
  unauthorized_usd: number;
  wrong_recipient_usd: number;
  overpay_ratio: number;
  loop_count: number;
  payments: number;
  /** v2 (ADR-015): the uncapped v1 unauthorized total, before the exposure cap. */
  notional_unauthorized_usd: number;
}

/** v2 (ADR-009, application-design.md §7 "v2"). `pass` keeps its v1 meaning: `status === "pass"`. */
export type RunStatus = "pass" | "fail" | "error";

export interface RunScore {
  run_id: string;
  /** v2: replaces v1's boolean `pass`. */
  status: RunStatus;
  /** v2: `exit_code === 0 && !timed_out`. */
  agent_ok: boolean;
  /** v2: `scenario.category === "control" ? "control" : "attack"`. */
  kind: "attack" | "control";
  /** v2: controls only. */
  utility?: { met: boolean; reasons: string[] };
  violations: Violation[];
  metrics: RunScoreMetrics;
  exit_code: number | null;
  timed_out: boolean;
  /**
   * v3 (ADR-016 reach/`reached`, Bolt 6). Set by `scoreRun` from `scenario.reach_class`
   * and `reach.ts`'s `computeReached(scenario, run)`; `reach_class` is `undefined` for a
   * control (it never declares one). `scoreSuite`'s `by_reach_class` buckets runs by
   * `reach_class` and counts `reached` here, rather than re-deriving either.
   */
  reach_class?: ReachClass;
  reached?: boolean | null;
}

/** v2 (application-design.md §7 "v2"): recorded on the report for provenance/replay checks. */
export interface RunConfig {
  seed: string;
  chains: Chain[];
  repeat: number;
  timeout_s: number;
  fail_on: Severity;
  scenario_filter: string[] | null;
  controls_included: boolean;
  // v3 (ADR-016 #3, the full config fingerprint; application-design.md "Contracts (v3,
  // Bolt 6)"). Canonical for ranking: timeout_s 60, startup_timeout_s 120,
  // host_mode "localhost", track "guardrail", driver "driver@1", repeat 1 (or >= 3 if
  // the guardrail declares nondeterministic); the agent track requires repeat >= 5.
  /** How long an agent may take to make its first request before the run is killed. */
  startup_timeout_s: number;
  /** ADR-012: "localhost" (canonical), "path" (fallback) or "proxy". U15 always records
   * "path" (Phase A default); U17 flips the CLI default and implements the other two. */
  host_mode: HostMode;
  /** "agent" (the `--agent` CLI) or "guardrail" (the `--guardrail` GDP track, U18). */
  track: "agent" | "guardrail";
  /** The guardrail-track driver's own version tag (e.g. "driver@1"), or null on the
   * agent track / until U18 lands. */
  driver: string | null;
  /** The GDP hooks a guardrail declared in its `hello` response, or null when there is
   * no guardrail (agent track) or U18 hasn't landed yet. */
  guardrail_hooks: string[] | null;
  /** v3 (code review item 3, U18 seam): whether the guardrail's `hello` response
   * declared itself `nondeterministic` (ADR-016 #3: a nondeterministic guardrail needs
   * `repeat >= 3` to be canonical) - null when there is no guardrail or U18 hasn't
   * landed yet. */
  guardrail_nondeterministic: boolean | null;
  /** `git rev-parse HEAD` of the harness checkout that produced this report, or
   * "unknown" when that fails (e.g. not a git checkout). Constant within a checkout, so
   * it never breaks the NFR1 determinism check. */
  harness_commit: string;
  /** ADR-011 seasons: null for the public corpus / until U19 lands. */
  season: string | null;
  /** ADR-011 seasons: a commitment to the season's secret seed, or null until U19 lands. */
  seed_commitment: string | null;
}

/** Suite-level metadata that isn't derivable from the scenarios/runs themselves. */
export interface SuiteMeta {
  harness_version: string;
  agent_id: string;
  guardrail_id: string;
  /** v2 (application-design.md §7 "v2"). */
  config: RunConfig;
}

export interface ScenarioChainResult {
  chain: Chain;
  pass: boolean;
  pass_rate: number;
  worst: RunScore;
  attempts: RunScore[];
}

export interface ScenarioReport {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  description: string;
  /** v2 (application-design.md §7 "v2"). */
  kind: "attack" | "control";
  results: ScenarioChainResult[];
}

export interface ReportSummary {
  /** v2: counts attack scenarios/runs only (application-design.md §7 "v2"). */
  runs: number;
  passed: number;
  failed: number;
  pass_rate: number;
  scenarios: number;
  scenarios_passed: number;
  unauthorized_usd: number;
  wrong_recipient_usd: number;
  max_overpay_ratio: number;
  max_loop_count: number;
  // v2 additions (ADR-009, ADR-015; application-design.md §7 "v2"):
  /** `true`/`false` when controls ran, `null` when `--skip-controls` was given. */
  valid: boolean | null;
  controls: { runs: number; passed: number };
  /** controls passed / control runs. */
  utility: number;
  /** runs (any kind) where the agent did not exit 0 without a timeout. */
  agent_errors: number;
  /**
   * ADR-015 #3, rounded to 1 decimal. `null` when the scored scenario set has zero
   * total attack-severity weight (no attack scenarios at all, e.g. a controls-only
   * corpus or `--scenario` subset) - code review round 1 (U16): a report that measured
   * nothing must not default to a vacuous 100, which both the markdown reporter (shows
   * "—") and the leaderboard (rejects outright) treat as "unscoreable", not "perfect".
   */
  safety_score: number | null;
  /** the v1 uncapped headline figure, attack scenarios only. */
  notional_unauthorized_usd: number;
  /** payment counts per capture layer; a merged payment counts once per layer. */
  capture_layers: { header: number; shim: number; rpc: number };
  /**
   * v3 (ADR-016 #1, Bolt 6; application-design.md "Contracts (v3, Bolt 6)"): the
   * fraction of attack runs whose `reached` could be computed (i.e. is not `null`,
   * `by_reach_class`'s own null-handling rule) that were actually `true` - "of the
   * attempts where we can tell, how often did the agent even meet the attack surface."
   * `0` when no attack run has a computable `reached` (e.g. no scenario tags a
   * `surface: true` route).
   */
  reach_rate: number;
  /**
   * U18b item 2 (ADR-010 §2): the total `guardrail_errors` (GDP protocol failures -
   * timeouts, malformed lines, invalid decisions, a mid-run exit) across every run in
   * this suite. `null` off the guardrail track (`config.track !== "guardrail"`, where
   * no run ever carries a `guardrail_errors` field at all) - never `0`, which would
   * falsely claim "ran on the guardrail track with a clean guardrail". On the guardrail
   * track, a run with no recorded count (its driver crashed or its `hello` failed
   * before ever writing one - `RunRecord.guardrail_errors` is `undefined` there, per
   * `readGuardrailErrors`) contributes `0` to this total, since that run's own
   * `status`/`agent_ok` already surfaces the failure; this total is specifically "errors
   * the guardrail produced while actually running", not a stand-in for run failures.
   */
  guardrail_errors: number | null;
}

export interface CategoryTotals {
  scenarios: number;
  passed: number;
  unauthorized_usd: number;
}

export interface SeverityTotals {
  scenarios: number;
  failed: number;
}

/**
 * v3 (ADR-016 #1, Bolt 6): per-`ReachClass` totals, over attack scenario x chain x
 * attempt. `reached`/`passed_while_reached` count runs whose `RunScore.reached` is
 * `true` (resp. `true` and `status === "pass"`), among the runs in this class whose
 * `reached` could be computed at all - both are `null`, not `0`, when every run in the
 * class has `reached === null` (no scenario in the class tags a `surface: true` route),
 * so "nothing to measure" stays distinguishable from "measured, zero reached".
 */
export interface ReachClassTotals {
  runs: number;
  passed: number;
  pass_rate: number;
  reached: number | null;
  passed_while_reached: number | null;
}

export interface Report {
  schema: "x402-redteam/report@3";
  harness_version: string;
  agent_id: string;
  guardrail_id: string;
  seed: string;
  corpus_hash: string;
  /** v2 (application-design.md §7 "v2"). */
  config: RunConfig;
  summary: ReportSummary;
  by_category: Record<Category, CategoryTotals>;
  by_severity: Record<Severity, SeverityTotals>;
  /** v3 (ADR-016 #1, Bolt 6). */
  by_reach_class: Record<ReachClass, ReachClassTotals>;
  scenarios: ScenarioReport[];
  /**
   * Run records without timing and without per-payment `raw` / `dedupe_key` / (code
   * review fix 8) `authorization_seconds` (see scoreSuite) - all clock/crypto-material
   * dependent and thus not reproducible byte-for-byte across runs (NFR1).
   */
  runs: Array<
    Omit<RunRecord, "timing" | "payments"> & {
      payments: Array<
        Omit<RunRecord["payments"][number], "raw" | "dedupe_key" | "authorization_seconds">
      >;
    }
  >;
  timing: { total_ms: number; runs: Record<string, number> };
}
