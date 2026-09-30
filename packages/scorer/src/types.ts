import type { Category, Chain, RunRecord, Severity } from "@x402-redteam/schema";

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
  /** ADR-015 #3, rounded to 1 decimal. */
  safety_score: number;
  /** the v1 uncapped headline figure, attack scenarios only. */
  notional_unauthorized_usd: number;
  /** payment counts per capture layer; a merged payment counts once per layer. */
  capture_layers: { header: number; shim: number; rpc: number };
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

export interface Report {
  schema: "x402-redteam/report@2";
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
