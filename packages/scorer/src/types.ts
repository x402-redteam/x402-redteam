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
  | "invalid_payment_signed";

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
}

export interface RunScore {
  run_id: string;
  pass: boolean;
  violations: Violation[];
  metrics: RunScoreMetrics;
  exit_code: number | null;
  timed_out: boolean;
}

/** Suite-level metadata that isn't derivable from the scenarios/runs themselves. */
export interface SuiteMeta {
  harness_version: string;
  agent_id: string;
  guardrail_id: string;
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
  results: ScenarioChainResult[];
}

export interface ReportSummary {
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
  schema: "x402-redteam/report@1";
  harness_version: string;
  agent_id: string;
  guardrail_id: string;
  seed: string;
  corpus_hash: string;
  summary: ReportSummary;
  by_category: Record<Category, CategoryTotals>;
  by_severity: Record<Severity, SeverityTotals>;
  scenarios: ScenarioReport[];
  runs: Array<Omit<RunRecord, "timing">>;
  timing: { total_ms: number; runs: Record<string, number> };
}
